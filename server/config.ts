import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { z } from "zod";
import voiceProfile from "./voice-profile.json";

if (existsSync(".env")) loadEnvFile(".env");

const dashscopeOrigin = z.url().refine((value): boolean => {
  const url = new URL(value);
  const supportedHost =
    ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com"].includes(
      url.hostname,
    ) ||
    /^[a-z0-9-]+\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(
      url.hostname,
    );
  return (
    supportedHost &&
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    !url.search &&
    !url.hash &&
    url.pathname === "/"
  );
}, "DASHSCOPE_BASE_URL must be a Beijing or Singapore DashScope HTTPS origin without an API path.");

const env = z
  .object({
    APP_MODE: z.enum(["mock", "live"]).default("mock"),
    PORT: z.coerce.number().int().min(1024).max(65535).default(3001),
    ENABLE_DEMO_FAULTS: z.enum(["true", "false"]).default("false"),
    DASHSCOPE_API_KEY: z.string().trim().default(""),
    DASHSCOPE_BASE_URL: dashscopeOrigin.default(
      "https://dashscope.aliyuncs.com",
    ),
    DASHSCOPE_LLM_MODEL: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .default("qwen3.7-plus"),
    DASHSCOPE_ASR_MODEL: z
      .string()
      .regex(/^qwen3-asr-flash(?:-\d{4}-\d{2}-\d{2})?$/)
      .default("qwen3-asr-flash"),
    DASHSCOPE_TTS_MODEL: z
      .string()
      .regex(/^qwen3-tts-(?:instruct-)?flash(?:-\d{4}-\d{2}-\d{2})?$/)
      .default(voiceProfile.model),
    DASHSCOPE_TTS_VOICE: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .default(voiceProfile.voice),
    DASHSCOPE_TTS_INSTRUCTIONS: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .default(voiceProfile.instructions),
  })
  .parse(process.env);

export const config = {
  ...env,
  production: process.argv.includes("--production"),
  dashscopeOrigin: new URL(env.DASHSCOPE_BASE_URL).origin,
  liveAvailable: Boolean(env.DASHSCOPE_API_KEY),
  demoFaults: env.ENABLE_DEMO_FAULTS === "true",
};

if (config.APP_MODE === "live" && !config.liveAvailable)
  throw new Error(
    "Live 未配置百炼密钥，请在 .env 中填写 DASHSCOPE_API_KEY，并确认其地域与 DASHSCOPE_BASE_URL 一致。",
  );
