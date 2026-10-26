import { randomUUID } from "node:crypto";
import type { AudioAsset } from "../shared/contracts";
import type { AudioBytes } from "./providers/types";
import { AppError } from "./errors";

interface StoredAudio extends AudioBytes {
  sessionId: string;
  turnId: string;
  expiresAt: number;
}

const items = new Map<string, StoredAudio>();

let totalBytes = 0;

function remove(id: string): void {
  const item = items.get(id);
  if (item) totalBytes -= item.bytes.length;
  items.delete(id);
}

export function cleanAudio(): void {
  for (const [id, item] of items) if (item.expiresAt < Date.now()) remove(id);
}

export function storeAudio(
  sessionId: string,
  turnId: string,
  audio: AudioBytes,
): AudioAsset {
  cleanAudio();
  if (audio.bytes.length > 5 * 1024 * 1024)
    throw new AppError(
      502,
      "AUDIO_TOO_LARGE",
      "语音文件过大，请重新尝试。",
      true,
    );
  while (totalBytes + audio.bytes.length > 64 * 1024 * 1024) {
    const oldest = items.keys().next().value;
    if (!oldest) break;
    remove(oldest);
  }
  const audioId = randomUUID();
  items.set(audioId, {
    ...audio,
    sessionId,
    turnId,
    expiresAt: Date.now() + 600_000,
  });
  totalBytes += audio.bytes.length;
  return {
    audioId,
    url: `/api/sessions/${sessionId}/audio/${audioId}`,
    mimeType: audio.mimeType,
  };
}

export function getAudio(sessionId: string, audioId: string): AudioBytes {
  const audio = items.get(audioId);
  if (!audio || audio.sessionId !== sessionId || audio.expiresAt < Date.now())
    throw new AppError(410, "AUDIO_EXPIRED", "语音已过期，请重新提问。", true);
  return audio;
}

export function clearAudio(sessionId: string, turnId?: string): void {
  for (const [id, audio] of items)
    if (audio.sessionId === sessionId && (!turnId || audio.turnId === turnId))
      remove(id);
}
