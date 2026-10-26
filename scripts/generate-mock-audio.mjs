import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { tsImport } from "tsx/esm/api";
import { z } from "zod";

const { BailianProvider } = await tsImport(
  "../server/providers/bailian.ts",
  import.meta.url,
);
const { config } = await tsImport("../server/config.ts", import.meta.url);
const voiceProfile = JSON.parse(
  await readFile(
    new URL("../server/voice-profile.json", import.meta.url),
    "utf8",
  ),
);
if (!config.liveAvailable) {
  throw new Error(
    "Set DASHSCOPE_API_KEY in the local .env before generating voice assets. Existing Mock files remain unchanged.",
  );
}
const dialogueSchema = z.record(
  z.string(),
  z.object({
    segments: z
      .array(
        z.object({
          text: z.string().trim().min(1).max(600),
          emotion: z.enum(["warm", "neutral", "curious"]),
        }),
      )
      .min(1),
  }),
);
const dialogue = dialogueSchema.parse(
  JSON.parse(await readFile(resolve("server/fixtures/dialogue.json"), "utf8")),
);
const provider = new BailianProvider();
const staging = await mkdtemp(join(tmpdir(), "mira-bailian-"));
const filenames = new Set();
const checksums = {};
try {
  for (const branch of Object.values(dialogue)) {
    for (const segment of branch.segments) {
      const filename = `${createHash("sha256").update(segment.text).digest("hex").slice(0, 16)}.wav`;
      if (filenames.has(filename)) continue;
      const audio = await provider.synthesize(
        segment.text,
        AbortSignal.timeout(30_000),
        segment.emotion,
      );
      await writeFile(join(staging, filename), audio.bytes);
      checksums[filename] = createHash("sha256")
        .update(audio.bytes)
        .digest("hex");
      filenames.add(filename);
      console.info(`Prepared voice asset ${filenames.size}`);
    }
  }
  const reference = await provider.synthesize(
    voiceProfile.referenceText,
    AbortSignal.timeout(30_000),
    "warm",
  );
  await writeFile(join(staging, "mira-reference.wav"), reference.bytes);
  for (const filename of filenames) {
    const destination = resolve("server/fixtures/audio", filename);
    const temporary = `${destination}.new`;
    await writeFile(temporary, await readFile(join(staging, filename)));
    await rename(temporary, destination);
  }
  const referencePath = resolve(voiceProfile.referenceAudio);
  await writeFile(
    `${referencePath}.new`,
    await readFile(join(staging, "mira-reference.wav")),
  );
  await rename(`${referencePath}.new`, referencePath);
  const manifestPath = resolve("public/assets/manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.audio = {
    source: "Alibaba Cloud Model Studio Qwen-TTS",
    sourceUrl: "https://help.aliyun.com/zh/model-studio/qwen-tts-api",
    format: "WAV from Qwen-TTS",
    directory: "server/fixtures/audio",
    characterVoice: {
      profile: voiceProfile.id,
      profilePath: "server/voice-profile.json",
      model: config.DASHSCOPE_TTS_MODEL,
      voice: config.DASHSCOPE_TTS_VOICE,
      language: voiceProfile.language,
      matchesProjectProfile:
        config.DASHSCOPE_TTS_MODEL === voiceProfile.model &&
        config.DASHSCOPE_TTS_VOICE === voiceProfile.voice,
      instructionsApplied: config.DASHSCOPE_TTS_MODEL.startsWith(
        "qwen3-tts-instruct-flash",
      ),
      instructions: config.DASHSCOPE_TTS_MODEL.startsWith(
        "qwen3-tts-instruct-flash",
      )
        ? config.DASHSCOPE_TTS_INSTRUCTIONS
        : null,
      referenceText: voiceProfile.referenceText,
      referenceAudio: voiceProfile.referenceAudio,
      referenceSha256: createHash("sha256")
        .update(reference.bytes)
        .digest("hex"),
      generator: "scripts/generate-mock-audio.mjs",
    },
    files: checksums,
    exampleInput: manifest.audio?.exampleInput,
    note: "Pre-generated through the same provider as Live. Runtime Mock playback is local. Existing demonstration videos and previews retain their original voices.",
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.info(`Installed ${filenames.size} Bailian voice assets.`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
