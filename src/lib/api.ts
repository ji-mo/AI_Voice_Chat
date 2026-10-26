import { z } from "zod";
import type {
  AppMode,
  DemoFault,
  HealthResponse,
  PlaybackReceipt,
  SessionResponse,
  TurnIdentity,
  TurnResponse,
} from "../../shared/contracts";
import {
  apiErrorSchema,
  healthSchema,
  sessionSchema,
  turnResponseSchema,
} from "../../shared/schemas";

export class ApiFailure extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable: boolean,
  ) {
    super(message);
  }
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
): Promise<T> {
  const deadline = AbortSignal.timeout(
    /\/(voice-)?turns$/.test(path) ? 50_000 : 10_000,
  );
  const signal = init.signal
    ? AbortSignal.any([init.signal, deadline])
    : deadline;
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      ...init,
      signal,
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    if (deadline.aborted)
      throw new ApiFailure(
        "NETWORK_TIMEOUT",
        "连接等待超时，请检查网络后重试。",
        true,
      );
    throw new ApiFailure("NETWORK", "连接断开了，请检查网络后重试。", true);
  }
  if (!response.ok) {
    const error = apiErrorSchema.safeParse(
      await response.json().catch((): null => null),
    );
    throw new ApiFailure(
      error.success ? error.data.code : "HTTP_ERROR",
      error.success ? error.data.message : "服务暂不可用，请稍后重试。",
      error.success ? error.data.retryable : true,
    );
  }
  if (response.status === 204) return schema.parse(undefined);
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ApiFailure("PROTOCOL", "回应没有完整送达，请重新尝试。", true);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ApiFailure("PROTOCOL", "回应格式不正确，请重新尝试。", true);
  return parsed.data;
}

function json(
  method: string,
  data: unknown,
  signal?: AbortSignal,
): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    signal,
  };
}

export const api = {
  health: (signal?: AbortSignal): Promise<HealthResponse> =>
    request("/api/health", healthSchema, { signal }),
  createSession: (
    mode: AppMode,
    signal?: AbortSignal,
  ): Promise<SessionResponse> =>
    request("/api/sessions", sessionSchema, json("POST", { mode }, signal)),
  deleteSession: (sessionId: string): Promise<void> =>
    request(`/api/sessions/${sessionId}`, z.undefined(), { method: "DELETE" }),
  interrupt: (
    sessionId: string,
    nextTurnSeq: number,
    previousReceipt: PlaybackReceipt | null,
  ): Promise<void> =>
    request(`/api/sessions/${sessionId}/interrupt`, z.undefined(), {
      ...json("POST", { nextTurnSeq, previousReceipt }),
      keepalive: true,
    }),
  playback: (sessionId: string, receipt: PlaybackReceipt): Promise<void> =>
    request(`/api/sessions/${sessionId}/playback`, z.undefined(), {
      ...json("POST", receipt),
      keepalive: true,
    }),
  exampleAudio: async (
    sessionId: string,
    signal: AbortSignal,
  ): Promise<Blob> => {
    const response = await fetch(`/api/sessions/${sessionId}/example-audio`, {
      signal,
      credentials: "same-origin",
    });
    if (!response.ok)
      throw new ApiFailure("EXAMPLE_AUDIO", "示例语音加载失败，请重试。", true);
    return response.blob();
  },
  text: (
    identity: TurnIdentity,
    text: string,
    previousReceipt: PlaybackReceipt | null,
    demoFault: DemoFault | undefined,
    signal: AbortSignal,
  ): Promise<TurnResponse> =>
    request(
      `/api/sessions/${identity.sessionId}/turns`,
      turnResponseSchema,
      json(
        "POST",
        {
          turnId: identity.turnId,
          turnSeq: identity.turnSeq,
          text,
          previousReceipt,
          demoFault,
        },
        signal,
      ),
    ),
  voice: (
    identity: TurnIdentity,
    audio: Blob,
    previousReceipt: PlaybackReceipt | null,
    demoFault: DemoFault | undefined,
    signal: AbortSignal,
  ): Promise<TurnResponse> => {
    const data = new FormData();
    data.append("turnId", identity.turnId);
    data.append("turnSeq", String(identity.turnSeq));
    data.append("previousReceipt", JSON.stringify(previousReceipt));
    if (demoFault) data.append("demoFault", demoFault);
    data.append(
      "audio",
      audio,
      audio.type.includes("wav")
        ? "recording.wav"
        : audio.type.includes("mp4")
          ? "recording.mp4"
          : "recording.webm",
    );
    return request(
      `/api/sessions/${identity.sessionId}/voice-turns`,
      turnResponseSchema,
      { method: "POST", body: data, signal },
    );
  },
};
