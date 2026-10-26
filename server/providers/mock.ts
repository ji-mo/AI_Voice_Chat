import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { CharacterReply, DialogueContext } from "../../shared/contracts";
import { replySchema } from "../../shared/schemas";
import { AppError, assertActive } from "../errors";
import type { AudioBytes, AudioInput, DialogueProvider } from "./types";
import dialogue from "../fixtures/dialogue.json";

export function audioFilename(text: string): string {
  return `${createHash("sha256").update(text).digest("hex").slice(0, 16)}.wav`;
}

export class MockProvider implements DialogueProvider {
  async transcribe(_input: AudioInput, signal: AbortSignal): Promise<string> {
    assertActive(signal);
    return "这是一段示例语音：可以给我看看你的照片吗？";
  }

  async generateReply(
    input: DialogueContext,
    signal: AbortSignal,
  ): Promise<CharacterReply> {
    await delay(450, undefined, { signal });
    const text = input.text.toLowerCase();
    let key: keyof typeof dialogue = "followup";
    if (/再见|告别|走了|晚安|bye/.test(text)) key = "farewell";
    else if (/照片|相片|灯塔|photo/.test(text))
      key =
        input.snapshot.storyNode === "photo_revealed" &&
        input.snapshot.photoVisible
          ? "photo_again"
          : "photo";
    else if (/雨|窗|weather|rain/.test(text)) key = "window";
    else if (/等|谁|朋友|约定/.test(text)) key = "waiting";
    else if (/旅行|摄影|拍摄|去过|工作/.test(text)) key = "travel";
    else if (/咖啡|喝|拿铁|coffee/.test(text)) key = "coffee";
    else if (/星|发夹|雨衣|名字|几岁|年龄/.test(text)) key = "identity";
    else if (/你好|hi|hello|坐|营业/.test(text) || !input.history.length)
      key = "greeting";
    else if (/谢谢|陪|祝|别担心|会来/.test(text)) key = "comfort";
    const reply = replySchema.parse(dialogue[key]);
    if (input.snapshot.storyNode === "photo_revealed") {
      for (const segment of reply.segments)
        segment.events = segment.events.filter(
          (event) => event.kind !== "story" || event.node !== "conversation",
        );
    }
    return reply;
  }

  async synthesize(text: string, signal: AbortSignal): Promise<AudioBytes> {
    assertActive(signal);
    try {
      const bytes = await readFile(
        resolve("server/fixtures/audio", audioFilename(text)),
        { signal },
      );
      return { bytes, mimeType: "audio/wav" };
    } catch (error) {
      assertActive(signal);
      console.error(
        JSON.stringify({
          stage: "mock_audio",
          code: error instanceof Error ? error.name : "UNKNOWN",
        }),
      );
      throw new AppError(
        502,
        "AUDIO_UNAVAILABLE",
        "本地演示语音加载失败。",
        true,
      );
    }
  }
}
