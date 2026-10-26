import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import multer from "multer";
import { z, ZodError } from "zod";
import {
  interruptSchema,
  modeSchema,
  receiptSchema,
  textRequestSchema,
  voiceRequestSchema,
} from "../shared/schemas";
import type { ApiError } from "../shared/contracts";
import { config } from "./config";
import { AppError } from "./errors";
import {
  applyReceipt,
  beginTurn,
  createSession,
  deleteSession,
  getSession,
  interruptSession,
  type Session,
} from "./session-store";
import { getAudio, clearAudio } from "./audio-store";
import { runTurn, type TurnInput } from "./turn-service";
import { validateFault } from "./demo-faults";

export const api = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5, fieldSize: 4096 },
});

const paramsSchema = z.object({ sessionId: z.uuid() });

function owner(request: Request): string {
  const match = /(?:^|;\s*)mira_owner=([a-f0-9-]{36})(?:;|$)/.exec(
    request.headers.cookie ?? "",
  );
  return match?.[1] ?? "";
}

function sessionFor(request: Request): Session {
  return getSession(
    paramsSchema.parse(request.params).sessionId,
    owner(request),
  );
}

api.use((request, _response, next): void => {
  const origin = request.get("origin");
  // Opaque or malformed origins are client errors, not upstream service failures.
  const originUrl = origin && URL.canParse(origin) ? new URL(origin) : null;
  if (
    request.get("sec-fetch-site") === "cross-site" ||
    (origin &&
      (!originUrl ||
        !["http:", "https:"].includes(originUrl.protocol) ||
        originUrl.origin !== origin ||
        originUrl.host !== request.get("host")))
  ) {
    next(new AppError(403, "ORIGIN", "请求来源不受支持。"));
    return;
  }
  next();
});

api.get("/health", (_request, response): void => {
  response.json({
    status: "ok",
    mode: config.APP_MODE,
    availableModes: config.liveAvailable ? ["mock", "live"] : ["mock"],
  });
});

api.post("/sessions", (request, response): void => {
  const body: unknown = request.body;
  const { mode = config.APP_MODE } = z
    .object({ mode: modeSchema.optional() })
    .strict()
    .parse(body ?? {});
  if (mode === "live" && !config.liveAvailable)
    throw new AppError(
      503,
      "LIVE_UNAVAILABLE",
      "真实对话尚未配置，请先使用演示模式。",
    );
  const token = owner(request) || randomUUID();
  const session = createSession(token, mode);
  response.cookie("mira_owner", token, {
    httpOnly: true,
    sameSite: "strict",
    secure: request.secure,
    maxAge: 1_800_000,
    path: "/",
  });
  response.json({
    sessionId: session.id,
    snapshot: session.snapshot,
    mode,
    demoFaults: config.demoFaults && mode === "mock",
  });
});

async function respondToTurn(
  request: Request,
  response: Response,
  session: Session,
  input: TurnInput,
): Promise<void> {
  const controller = beginTurn(session, input.turnId, input.turnSeq);
  const onClose = (): void => {
    if (!response.writableEnded) {
      controller.abort();
      clearAudio(session.id, input.turnId);
    }
  };
  response.on("close", onClose);
  try {
    const result = await runTurn(session, input, controller.signal);
    if (!response.destroyed) response.json(result);
  } finally {
    response.off("close", onClose);
    if (request.aborted) controller.abort();
  }
}

api.post(
  "/sessions/:sessionId/turns",
  async (request, response): Promise<void> => {
    const session = sessionFor(request);
    const body: unknown = request.body;
    const input = textRequestSchema.parse(body);
    validateFault(session.mode, input.demoFault);
    applyReceipt(session, input.previousReceipt);
    await respondToTurn(request, response, session, {
      ...input,
      sessionId: session.id,
    });
  },
);

api.post(
  "/sessions/:sessionId/voice-turns",
  (request, _response, next): void => {
    sessionFor(request);
    next();
  },
  upload.single("audio"),
  async (request, response): Promise<void> => {
    const session = sessionFor(request);
    const raw: unknown = request.body;
    const fields = z
      .object({
        turnId: z.string(),
        turnSeq: z.string(),
        previousReceipt: z.string(),
        demoFault: z.string().optional(),
      })
      .strict()
      .parse(raw);
    let previousReceipt: unknown;
    try {
      previousReceipt = JSON.parse(fields.previousReceipt);
    } catch {
      throw new AppError(400, "INVALID_RECEIPT", "播放记录格式不正确。");
    }
    const input = voiceRequestSchema.parse({
      ...fields,
      turnSeq: Number(fields.turnSeq),
      previousReceipt,
    });
    validateFault(session.mode, input.demoFault);
    const file = request.file;
    if (!file?.buffer.length)
      throw new AppError(
        422,
        "EMPTY_SPEECH",
        "没有收到录音，请重新尝试。",
        true,
      );
    const mime = file.mimetype.split(";")[0];
    const webm = file.buffer
      .subarray(0, 4)
      .equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    const mp4 = file.buffer.subarray(4, 8).toString() === "ftyp";
    const wav =
      file.buffer.subarray(0, 4).toString() === "RIFF" &&
      file.buffer.subarray(8, 12).toString() === "WAVE";
    if (!(
      (mime === "audio/webm" && webm) ||
      (mime === "audio/mp4" && mp4) ||
      (mime === "audio/wav" && wav)
    ))
      throw new AppError(
        415,
        "AUDIO_FORMAT",
        "这段录音格式暂不支持，请改用文字。",
      );
    applyReceipt(session, input.previousReceipt);
    await respondToTurn(request, response, session, {
      ...input,
      sessionId: session.id,
      audio: {
        bytes: file.buffer,
        mimeType: mime,
        filename: `recording.${webm ? "webm" : mp4 ? "mp4" : "wav"}`,
      },
    });
  },
);

api.post("/sessions/:sessionId/interrupt", (request, response): void => {
  const session = sessionFor(request);
  const body: unknown = request.body;
  const input = interruptSchema.parse(body);
  applyReceipt(session, input.previousReceipt);
  interruptSession(session, input.nextTurnSeq);
  response.sendStatus(204);
});

api.post("/sessions/:sessionId/playback", (request, response): void => {
  const body: unknown = request.body;
  applyReceipt(sessionFor(request), receiptSchema.parse(body));
  response.sendStatus(204);
});

api.delete("/sessions/:sessionId", (request, response): void => {
  deleteSession(sessionFor(request));
  response.sendStatus(204);
});

api.get(
  "/sessions/:sessionId/example-audio",
  async (request, response): Promise<void> => {
    const session = sessionFor(request);
    if (session.mode !== "mock")
      throw new AppError(400, "MOCK_ONLY", "示例语音仅在演示模式可用。");
    const bytes = await readFile(resolve("server/fixtures/example-input.wav"));
    response
      .set({
        "Content-Type": "audio/wav",
        "Cache-Control": "private, no-store",
      })
      .send(bytes);
  },
);

api.get("/sessions/:sessionId/audio/:audioId", (request, response): void => {
  const session = sessionFor(request);
  const audio = getAudio(session.id, z.uuid().parse(request.params.audioId));
  response.set({
    "Content-Type": audio.mimeType,
    "Cache-Control": "private, no-store",
    "Accept-Ranges": "bytes",
  });
  const range = request.get("range");
  // Browsers may probe a small byte range before starting media playback.
  if (!range) {
    response.send(audio.bytes);
    return;
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  const start = Number(match?.[1]);
  const end = match?.[2]
    ? Math.min(Number(match[2]), audio.bytes.length - 1)
    : audio.bytes.length - 1;
  if (
    !match ||
    !Number.isSafeInteger(start) ||
    start > end ||
    start >= audio.bytes.length
  ) {
    response
      .status(416)
      .set("Content-Range", `bytes */${audio.bytes.length}`)
      .end();
    return;
  }
  response
    .status(206)
    .set("Content-Range", `bytes ${start}-${end}/${audio.bytes.length}`)
    .send(audio.bytes.subarray(start, end + 1));
});

api.use((_request, _response, next): void => {
  next(new AppError(404, "NOT_FOUND", "未找到请求的内容。"));
});

export function errorHandler(
  error: unknown,
  request: Request,
  response: Response,
  _next: NextFunction,
): void {
  if (response.headersSent || response.destroyed) return;
  let failure =
    error instanceof AppError
      ? error
      : new AppError(502, "SERVICE_ERROR", "暂时无法回应，请稍后重试。", true);
  if (error instanceof ZodError || error instanceof SyntaxError)
    failure = new AppError(
      400,
      "INVALID_INPUT",
      "输入格式不正确，请检查后重新发送。",
    );
  if (error instanceof multer.MulterError)
    failure = new AppError(
      error.code === "LIMIT_FILE_SIZE" ? 413 : 400,
      "UPLOAD_LIMIT",
      "录音过大或上传内容不正确，请缩短录音。",
    );
  console.error(
    JSON.stringify({
      path: request.path,
      code: failure.code,
      status: failure.status,
    }),
  );
  const result: ApiError = {
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
    turnId: null,
  };
  response.status(failure.status).json(result);
}
