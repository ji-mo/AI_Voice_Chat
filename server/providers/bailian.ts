import { z } from "zod";
import type {
  CharacterReply,
  DialogueContext,
  Emotion,
} from "../../shared/contracts";
import { modelReplySchema, replySchema } from "../../shared/schemas";
import { config } from "../config";
import voiceProfile from "../voice-profile.json";
import { AppError, assertActive } from "../errors";
import { characterInstructions } from "../story";
import type { AudioBytes, AudioInput, DialogueProvider } from "./types";

const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

const MAX_JSON_BYTES = 8 * 1024 * 1024;

const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable(),
        message: z.object({
          content: z.string().nullable(),
          refusal: z.string().nullish(),
        }),
      }),
    )
    .min(1),
});

const serviceErrorSchema = z.object({
  status_code: z.number().optional(),
  code: z.string().optional(),
  error: z
    .object({ code: z.union([z.string(), z.number()]).optional() })
    .optional(),
});

const speechSchema = z.object({
  output: z.object({
    finish_reason: z.string().nullish(),
    audio: z.object({
      url: z.string().nullish(),
      data: z.string().nullish(),
      expires_at: z.number().nullish(),
    }),
  }),
});

const replyJsonSchema = JSON.stringify(z.toJSONSchema(modelReplySchema));

const replyFormatInstructions = [
  "Return only a JSON object matching this JSON Schema.",
  "Do not include Markdown fences or narration outside the JSON.",
  "Camera and photo events use segment_start.",
  "Story events MUST use segment_end, after the spoken sentence finishes.",
].join(" ");

const emotionInstructions: Record<Emotion, string> =
  voiceProfile.emotionInstructions;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStoryTiming(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.segments)) return value;
  return {
    ...value,
    segments: value.segments.map((segment: unknown): unknown => {
      if (!isRecord(segment) || !Array.isArray(segment.events)) return segment;
      return {
        ...segment,
        events: segment.events.map((event: unknown): unknown => {
          // Story facts are committed after playback, regardless of model timing.
          if (
            isRecord(event) &&
            event.kind === "story" &&
            event.trigger === "segment_start"
          ) {
            return { ...event, trigger: "segment_end" };
          }
          return event;
        }),
      };
    }),
  };
}

function serviceError(status: number, code = ""): AppError {
  if (
    status === 401 ||
    /InvalidApiKey|InvalidAuthentication|InvalidAccessKey/i.test(code)
  ) {
    return new AppError(
      503,
      "BAILIAN_AUTH",
      "百炼鉴权失败，请检查 API Key 及其所属地域。",
      false,
    );
  }
  if (status === 403)
    return new AppError(
      503,
      "BAILIAN_ACCESS",
      "百炼模型尚未开通或账号无权访问，请检查模型权限。",
      false,
    );
  if (status === 429 || /Throttl|RateLimit/i.test(code))
    return new AppError(
      429,
      "BAILIAN_RATE_LIMIT",
      "百炼调用频率或额度受限，请稍后重试。",
      true,
    );
  if (status === 402 || /Quota|Balance|Overdue/i.test(code))
    return new AppError(
      503,
      "BAILIAN_QUOTA",
      "百炼可用额度不足，请检查账户余额或资源额度。",
      false,
    );
  if (status === 404)
    return new AppError(
      502,
      "BAILIAN_MODEL_UNAVAILABLE",
      "当前百炼模型不可用，请检查模型名称、权限及地域配置。",
      false,
    );
  if (status === 400)
    return new AppError(
      502,
      "BAILIAN_CONFIGURATION",
      "百炼未接受请求，请检查模型、音色及地域配置。",
      false,
    );
  if (status === 408 || status === 504)
    return new AppError(
      504,
      "BAILIAN_TIMEOUT",
      "百炼响应超时，请重新尝试。",
      true,
    );
  return new AppError(
    502,
    "BAILIAN_SERVICE",
    "百炼服务暂时无法回应，请稍后重试。",
    true,
  );
}

async function readBounded(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<Buffer> {
  assertActive(signal);
  const length = Number(response.headers.get("content-length"));
  if (length > limit) {
    await response.body?.cancel();
    throw new AppError(
      502,
      "BAILIAN_RESPONSE_SIZE",
      "百炼返回内容过大，请重新尝试。",
      true,
    );
  }
  if (!response.body)
    throw new AppError(
      502,
      "BAILIAN_EMPTY",
      "百炼没有返回内容，请重新尝试。",
      true,
    );
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      assertActive(signal);
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new AppError(
          502,
          "BAILIAN_RESPONSE_SIZE",
          "百炼返回内容过大，请重新尝试。",
          true,
        );
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  assertActive(signal);
  return Buffer.concat(chunks, size);
}

async function requestJson(
  path: string,
  body: object,
  signal: AbortSignal,
): Promise<unknown> {
  assertActive(signal);
  if (!config.liveAvailable)
    throw new AppError(
      503,
      "LIVE_UNAVAILABLE",
      "请先配置百炼 DASHSCOPE_API_KEY。",
      false,
    );
  let response: Response;
  try {
    response = await fetch(`${config.dashscopeOrigin}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.DASHSCOPE_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal,
      redirect: "error",
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new AppError(
      502,
      "BAILIAN_NETWORK",
      "无法连接百炼，请检查服务端网络后重试。",
      true,
    );
  }
  const bytes = await readBounded(response, MAX_JSON_BYTES, signal);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    if (!response.ok) throw serviceError(response.status);
    throw new AppError(
      502,
      "BAILIAN_PROTOCOL",
      "百炼返回内容无法解析，请重试。",
      true,
    );
  }
  const envelope = serviceErrorSchema.safeParse(value);
  const status = envelope.success
    ? (envelope.data.status_code ?? response.status)
    : response.status;
  const code = envelope.success
    ? String(envelope.data.code || envelope.data.error?.code || "")
    : "";
  if (!response.ok || status >= 400 || code) throw serviceError(status, code);
  return value;
}

function completionText(value: unknown, allowEmpty: boolean): string {
  const result = completionSchema.safeParse(value);
  const choice = result.success ? result.data.choices[0] : undefined;
  if (!choice || choice.finish_reason !== "stop" || choice.message.refusal) {
    throw new AppError(
      502,
      "BAILIAN_RESPONSE",
      "这次回应未能完整生成，请换个说法再试。",
      true,
    );
  }
  const text = choice.message.content?.trim() ?? "";
  if (!text && !allowEmpty)
    throw new AppError(
      502,
      "BAILIAN_EMPTY",
      "百炼没有返回有效回复，请重新尝试。",
      true,
    );
  return text;
}

function trustedAudioUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError(502, "BAILIAN_AUDIO_URL", "语音下载地址无效。", true);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    !/^dashscope-result-[a-z0-9-]+\.oss-[a-z0-9-]+\.aliyuncs\.com$/.test(
      url.hostname,
    )
  )
    throw new AppError(
      502,
      "BAILIAN_AUDIO_URL",
      "百炼返回了不受支持的语音地址。",
      true,
    );
  url.protocol = "https:";
  return url;
}

function validateWav(bytes: Buffer): AudioBytes {
  if (
    bytes.length < 44 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new AppError(
      502,
      "BAILIAN_AUDIO_FORMAT",
      "百炼语音格式无效，请重新尝试。",
      true,
    );
  }
  const declaredRiffSize = bytes.readUInt32LE(4);
  const streamingSize = declaredRiffSize >= 0x7fff0000;
  if (!streamingSize && declaredRiffSize + 8 > bytes.length) {
    throw new AppError(
      502,
      "BAILIAN_AUDIO_FORMAT",
      "百炼语音文件不完整。",
      true,
    );
  }
  const normalized = Buffer.from(bytes);
  let formatValid = false;
  let hasSamples = false;
  let pcmBlockAlign = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = bytes.toString("ascii", offset, offset + 4);
    let length = bytes.readUInt32LE(offset + 4);
    if (offset + 8 + length > bytes.length) {
      const remaining = bytes.length - offset - 8;
      // Qwen can retain near-INT_MAX streaming sizes in a completed PCM WAV.
      // Only normalize that sentinel case; ordinary truncated files still fail.
      if (
        kind !== "data" ||
        !streamingSize ||
        length < 0x7fff0000 ||
        !pcmBlockAlign ||
        remaining <= 0 ||
        remaining % pcmBlockAlign
      ) {
        throw new AppError(
          502,
          "BAILIAN_AUDIO_FORMAT",
          "百炼语音文件不完整。",
          true,
        );
      }
      length = remaining;
      normalized.writeUInt32LE(length, offset + 4);
    }
    if (kind === "fmt " && length >= 16) {
      const encoding = bytes.readUInt16LE(offset + 8);
      const channels = bytes.readUInt16LE(offset + 10);
      const sampleRate = bytes.readUInt32LE(offset + 12);
      const blockAlign = bytes.readUInt16LE(offset + 20);
      const bits = bytes.readUInt16LE(offset + 22);
      formatValid =
        [1, 3, 65534].includes(encoding) && channels > 0 && sampleRate > 0;
      if (
        encoding === 1 &&
        [1, 2].includes(channels) &&
        bits === 16 &&
        blockAlign === channels * 2 &&
        bytes.readUInt32LE(offset + 16) === sampleRate * blockAlign
      ) {
        pcmBlockAlign = blockAlign;
      }
    }
    if (kind === "data" && length > 0) hasSamples = true;
    offset += 8 + length + (length % 2);
  }
  if (!formatValid || !hasSamples) {
    throw new AppError(
      502,
      "BAILIAN_AUDIO_EMPTY",
      "百炼没有返回可播放的语音。",
      true,
    );
  }
  if (streamingSize) normalized.writeUInt32LE(normalized.length - 8, 4);
  return { bytes: normalized, mimeType: "audio/wav" };
}

function decodeInlineAudio(encoded: string): AudioBytes {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  ) {
    throw new AppError(502, "BAILIAN_AUDIO_FORMAT", "百炼语音编码无效。", true);
  }
  const pcm = Buffer.from(encoded, "base64");
  if (!pcm.length || pcm.length > MAX_AUDIO_BYTES - 44)
    throw new AppError(
      502,
      "BAILIAN_AUDIO_SIZE",
      "百炼语音为空或超过大小限制。",
      true,
    );
  if (pcm.toString("ascii", 0, 4) === "RIFF") return validateWav(pcm);
  if (pcm.length % 2)
    throw new AppError(
      502,
      "BAILIAN_AUDIO_FORMAT",
      "百炼语音采样数据不完整。",
      true,
    );
  // Qwen3-TTS inline audio is mono 24 kHz, signed 16-bit little-endian PCM.
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(pcm.length + 36, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return { bytes: Buffer.concat([header, pcm]), mimeType: "audio/wav" };
}

export class BailianProvider implements DialogueProvider {
  async transcribe(input: AudioInput, signal: AbortSignal): Promise<string> {
    if (
      !input.bytes.length ||
      input.bytes.length > MAX_AUDIO_BYTES ||
      !["audio/webm", "audio/mp4", "audio/wav"].includes(input.mimeType)
    ) {
      throw new AppError(
        400,
        "INVALID_AUDIO",
        "录音为空、格式不支持或超过大小限制。",
        false,
      );
    }
    const result = await requestJson(
      "/compatible-mode/v1/chat/completions",
      {
        model: config.DASHSCOPE_ASR_MODEL,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "input_audio",
                input_audio: {
                  data: `data:${input.mimeType};base64,${input.bytes.toString("base64")}`,
                },
              },
            ],
          },
        ],
        stream: false,
        asr_options: { language: "zh", enable_itn: false },
      },
      signal,
    );
    return completionText(result, true);
  }

  async generateReply(
    input: DialogueContext,
    signal: AbortSignal,
  ): Promise<CharacterReply> {
    const result = await requestJson(
      "/compatible-mode/v1/chat/completions",
      {
        model: config.DASHSCOPE_LLM_MODEL,
        messages: [
          {
            role: "system",
            content: [
              characterInstructions,
              voiceProfile.phrasingInstructions,
              replyFormatInstructions,
              replyJsonSchema,
            ].join("\n"),
          },
          { role: "user", content: JSON.stringify(input) },
        ],
        response_format: { type: "json_object" },
        enable_thinking: false,
        stream: false,
        max_completion_tokens: 1800,
      },
      signal,
    );
    const content = completionText(result, false);
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw new AppError(
        502,
        "BAILIAN_REPLY_FORMAT",
        "角色回应格式不正确，请重新尝试。",
        true,
      );
    }
    const reply = replySchema.safeParse(normalizeStoryTiming(value));
    if (!reply.success)
      throw new AppError(
        502,
        "BAILIAN_REPLY_FORMAT",
        "角色回应不符合场景指令，请重新尝试。",
        true,
      );
    return reply.data;
  }

  async synthesize(
    text: string,
    signal: AbortSignal,
    emotion: Emotion = "neutral",
  ): Promise<AudioBytes> {
    if (!text.trim() || text.length > 600)
      throw new AppError(
        400,
        "INVALID_SPEECH_TEXT",
        "语音文本为空或过长。",
        false,
      );
    const instructionFields = config.DASHSCOPE_TTS_MODEL.startsWith(
      "qwen3-tts-instruct-flash",
    )
      ? {
          instructions: `${config.DASHSCOPE_TTS_INSTRUCTIONS} ${emotionInstructions[emotion]}`,
          optimize_instructions: true,
        }
      : {};
    const result = await requestJson(
      "/api/v1/services/aigc/multimodal-generation/generation",
      {
        model: config.DASHSCOPE_TTS_MODEL,
        input: {
          text,
          voice: config.DASHSCOPE_TTS_VOICE,
          language_type: voiceProfile.language,
        },
        parameters: instructionFields,
      },
      signal,
    );
    const parsed = speechSchema.safeParse(result);
    if (
      !parsed.success ||
      (parsed.data.output.finish_reason &&
        parsed.data.output.finish_reason !== "stop")
    ) {
      throw new AppError(
        502,
        "BAILIAN_AUDIO_RESPONSE",
        "百炼语音未能完整生成，请重新尝试。",
        true,
      );
    }
    const audio = parsed.data.output.audio;
    if (audio.expires_at && audio.expires_at * 1000 <= Date.now())
      throw new AppError(
        502,
        "BAILIAN_AUDIO_EXPIRED",
        "百炼语音下载地址已过期，请重新尝试。",
        true,
      );
    if (audio.url) {
      const url = trustedAudioUrl(audio.url);
      let response: Response;
      try {
        response = await fetch(url, { signal, redirect: "error" });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new AppError(
          502,
          "BAILIAN_AUDIO_DOWNLOAD",
          "语音下载失败，请重新尝试。",
          true,
        );
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError(
          502,
          "BAILIAN_AUDIO_DOWNLOAD",
          "语音下载失败，请重新尝试。",
          true,
        );
      }
      return validateWav(await readBounded(response, MAX_AUDIO_BYTES, signal));
    }
    if (audio.data) return decodeInlineAudio(audio.data);
    throw new AppError(
      502,
      "BAILIAN_AUDIO_EMPTY",
      "百炼没有返回可播放的语音。",
      true,
    );
  }
}
