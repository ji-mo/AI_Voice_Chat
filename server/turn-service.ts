import { randomUUID } from "node:crypto";
import type {
  DemoFault,
  RenderableSegment,
  TurnIdentity,
  TurnResponse,
} from "../shared/contracts";
import { replySchema } from "../shared/schemas";
import { applyDemoFault } from "./demo-faults";
import { AppError, assertActive, logStage } from "./errors";
import { clearAudio, storeAudio } from "./audio-store";
import { getHistory, saveResponse, type Session } from "./session-store";
import { validateStory } from "./story";
import { MockProvider } from "./providers/mock";
import { BailianProvider } from "./providers/bailian";
import type { AudioInput, DialogueProvider } from "./providers/types";

export interface TurnInput extends TurnIdentity {
  text?: string;
  audio?: AudioInput;
  demoFault?: DemoFault;
}

const mock = new MockProvider();

let live: DialogueProvider | undefined;

async function stage<T>(
  turnId: string,
  name: string,
  timeout: number,
  signal: AbortSignal,
  operation: (stageSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  assertActive(signal);
  const started = performance.now();
  const deadline = AbortSignal.timeout(timeout);
  try {
    const result = await operation(AbortSignal.any([signal, deadline]));
    assertActive(signal);
    logStage(turnId, name, performance.now() - started, "ok");
    return result;
  } catch (error) {
    logStage(
      turnId,
      name,
      performance.now() - started,
      signal.aborted ? "cancelled" : deadline.aborted ? "timeout" : "failed",
    );
    assertActive(signal);
    if (deadline.aborted)
      throw new AppError(
        504,
        `${name.toUpperCase()}_TIMEOUT`,
        "回应等待超时，请重新尝试。",
        true,
      );
    throw error;
  }
}

export async function runTurn(
  session: Session,
  input: TurnInput,
  parentSignal: AbortSignal,
): Promise<TurnResponse> {
  const deadline = AbortSignal.timeout(45_000);
  // Cancelling a turn also cancels every currently running provider stage.
  const signal = AbortSignal.any([parentSignal, deadline]);
  const provider =
    session.mode === "mock" ? mock : (live ??= new BailianProvider());
  try {
    await applyDemoFault(input.demoFault, signal);
    const audioInput = input.audio;
    const text = audioInput
      ? await stage(input.turnId, "stt", 15_000, signal, (stageSignal) =>
          provider.transcribe(audioInput, stageSignal),
        )
      : (input.text ?? "");
    if (!text.trim())
      throw new AppError(
        422,
        "EMPTY_SPEECH",
        "没有听清，请按住按钮再说一次。",
        true,
      );
    if (text.length > 500)
      throw new AppError(
        400,
        "INPUT_TOO_LONG",
        "这段话有点长，请分成短句再说。",
      );
    const reply = validateStory(
      replySchema.parse(
        await stage(input.turnId, "llm", 20_000, signal, (stageSignal) =>
          provider.generateReply(
            {
              text,
              snapshot: { ...session.snapshot },
              history: getHistory(session),
            },
            stageSignal,
          ),
        ),
      ),
      session.snapshot,
    );
    const segments: RenderableSegment[] = [];
    const warnings: string[] = [];
    // Bound synthesis concurrency while preserving the model's sentence order.
    for (let offset = 0; offset < reply.segments.length; offset += 2) {
      const batch = await Promise.all(
        reply.segments
          .slice(offset, offset + 2)
          .map(async (segment): Promise<RenderableSegment> => {
            let audio = null;
            try {
              if (input.demoFault === "audio_failure")
                throw new AppError(502, "AUDIO_UNAVAILABLE", "演示语音故障");
              const bytes = await stage(
                input.turnId,
                "tts",
                15_000,
                signal,
                (stageSignal) =>
                  provider.synthesize(
                    segment.text,
                    stageSignal,
                    segment.emotion,
                  ),
              );
              assertActive(signal);
              audio = storeAudio(session.id, input.turnId, bytes);
            } catch (error) {
              assertActive(signal);
              console.error(
                JSON.stringify({
                  turnId: input.turnId,
                  stage: "tts_fallback",
                  code:
                    error instanceof AppError ? error.code : "PROVIDER_ERROR",
                }),
              );
              if (!warnings.includes("AUDIO_UNAVAILABLE"))
                warnings.push("AUDIO_UNAVAILABLE");
              if (error instanceof AppError) {
                const warning = `AUDIO_UNAVAILABLE:${error.code}`;
                if (!warnings.includes(warning)) warnings.push(warning);
              }
            }
            return {
              ...segment,
              segmentId: randomUUID(),
              events: segment.events.map((event) => ({
                ...event,
                eventId: randomUUID(),
              })),
              audio,
            };
          }),
      );
      segments.push(...batch);
    }
    assertActive(signal);
    const response: TurnResponse = {
      sessionId: session.id,
      turnId: input.turnId,
      turnSeq: input.turnSeq,
      mode: session.mode,
      inputText: text,
      segments,
      warnings,
    };
    saveResponse(session, response);
    return response;
  } catch (error) {
    clearAudio(session.id, input.turnId);
    if (deadline.aborted && !parentSignal.aborted)
      throw new AppError(
        504,
        "TURN_TIMEOUT",
        "等得有些久了，请重新尝试。",
        true,
      );
    assertActive(parentSignal);
    throw error;
  }
}
