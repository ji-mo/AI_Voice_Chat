import { randomUUID } from "node:crypto";
import type {
  AppMode,
  HistoryEntry,
  PlaybackReceipt,
  SceneSnapshot,
  TurnResponse,
} from "../shared/contracts";
import { initialSnapshot } from "../shared/contracts";
import { clearAudio, cleanAudio } from "./audio-store";
import { AppError } from "./errors";

interface TurnRecord {
  sequence: number;
  input: string;
  response?: TurnResponse;
  completed: Set<string>;
  read: Set<string>;
  events: Set<string>;
  interrupted: boolean;
}

export interface Session {
  id: string;
  owner: string;
  mode: AppMode;
  snapshot: SceneSnapshot;
  minAcceptedSeq: number;
  lastStartedSeq: number;
  touchedAt: number;
  requests: number[];
  turns: Map<string, TurnRecord>;
  fieldOrder: Map<string, number>;
  active?: { turnId: string; sequence: number; controller: AbortController };
}

const sessions = new Map<string, Session>();

export function deleteSession(session: Session): void {
  session.active?.controller.abort();
  clearAudio(session.id);
  sessions.delete(session.id);
}

export function cleanSessions(): void {
  for (const session of sessions.values())
    if (Date.now() - session.touchedAt > 1_800_000) deleteSession(session);
  cleanAudio();
}

export function createSession(owner: string, mode: AppMode): Session {
  cleanSessions();
  if (sessions.size >= 100)
    throw new AppError(503, "BUSY", "咖啡馆暂时有些忙，请稍后再试。", true);
  const owned = Array.from(sessions.values())
    .filter((session) => session.owner === owner)
    .sort((a, b) => a.touchedAt - b.touchedAt);
  while (owned.length >= 4) {
    const oldest = owned.shift();
    if (oldest) deleteSession(oldest);
  }
  const session: Session = {
    id: randomUUID(),
    owner,
    mode,
    snapshot: { ...initialSnapshot },
    minAcceptedSeq: 1,
    lastStartedSeq: 0,
    touchedAt: Date.now(),
    requests: [],
    turns: new Map(),
    fieldOrder: new Map(),
  };
  sessions.set(session.id, session);
  return session;
}

export function getSession(id: string, owner: string): Session {
  const session = sessions.get(id);
  if (
    !session ||
    session.owner !== owner ||
    Date.now() - session.touchedAt > 1_800_000
  )
    throw new AppError(
      410,
      "SESSION_EXPIRED",
      "这次相遇已结束，请重新进入场景。",
    );
  session.touchedAt = Date.now();
  return session;
}

export function interruptSession(session: Session, nextSequence: number): void {
  session.minAcceptedSeq = Math.max(session.minAcceptedSeq, nextSequence);
  if (session.active && session.active.sequence < nextSequence) {
    session.active.controller.abort();
    const previous = session.turns.get(session.active.turnId);
    // Starting a normal next turn also cancels the previous controller.
    // Preserve the distinction between a finished reply and an interrupted one.
    if (previous) {
      previous.interrupted ||=
        !previous.response ||
        previous.response.segments.some(
          (segment): boolean =>
            !previous.completed.has(segment.segmentId) &&
            !previous.read.has(segment.segmentId),
        );
    }
    clearAudio(session.id, session.active.turnId);
    session.active = undefined;
  }
}

export function beginTurn(
  session: Session,
  turnId: string,
  sequence: number,
): AbortController {
  if (
    sequence < session.minAcceptedSeq ||
    sequence <= session.lastStartedSeq ||
    session.turns.has(turnId)
  )
    throw new AppError(409, "STALE_TURN", "这次输入已失效，请重新发送。");
  const now = Date.now();
  session.requests = session.requests.filter((time) => now - time < 60_000);
  if (session.requests.length >= 20)
    throw new AppError(429, "RATE_LIMIT", "先歇一小会儿，稍后再聊。", true);
  interruptSession(session, sequence);
  session.lastStartedSeq = sequence;
  session.requests.push(now);
  const controller = new AbortController();
  session.active = { turnId, sequence, controller };
  session.turns.set(turnId, {
    sequence,
    input: "",
    completed: new Set(),
    read: new Set(),
    events: new Set(),
    interrupted: false,
  });
  while (session.turns.size > 24) {
    const oldest = session.turns.keys().next().value;
    if (!oldest) break;
    clearAudio(session.id, oldest);
    session.turns.delete(oldest);
  }
  return controller;
}

export function saveResponse(session: Session, response: TurnResponse): void {
  const record = session.turns.get(response.turnId);
  if (
    !record ||
    session.active?.turnId !== response.turnId ||
    session.active.controller.signal.aborted
  )
    throw new AppError(409, "CANCELLED", "这轮回复已经停止。");
  record.input = response.inputText;
  record.response = response;
}

export function applyReceipt(
  session: Session,
  receipt: PlaybackReceipt | null,
): void {
  if (!receipt) return;
  const record = session.turns.get(receipt.turnId);
  if (!record?.response) return;
  const { segments } = record.response;
  const segmentIds = new Set(segments.map((segment) => segment.segmentId));
  const eventIds = new Set(
    segments.flatMap((segment) => segment.events.map((event) => event.eventId)),
  );
  if (
    [...receipt.completedSegmentIds, ...receipt.readSegmentIds].some(
      (id) => !segmentIds.has(id),
    ) ||
    receipt.appliedEventIds.some((id) => !eventIds.has(id))
  )
    throw new AppError(400, "INVALID_RECEIPT", "播放记录不匹配。");
  for (const id of receipt.completedSegmentIds)
    if (!record.read.has(id)) record.completed.add(id);
  for (const id of receipt.readSegmentIds)
    if (!record.completed.has(id)) record.read.add(id);
  for (const [segmentIndex, segment] of segments.entries()) {
    for (const [eventIndex, event] of segment.events.entries()) {
      if (
        !receipt.appliedEventIds.includes(event.eventId) ||
        record.events.has(event.eventId)
      )
        continue;
      if (
        event.trigger === "segment_end" &&
        !record.completed.has(segment.segmentId) &&
        !record.read.has(segment.segmentId)
      )
        continue;
      record.events.add(event.eventId);
      // Receipts can arrive out of order; older events cannot overwrite newer fields.
      const order = record.sequence * 100 + segmentIndex * 10 + eventIndex;
      if ((session.fieldOrder.get(event.kind) ?? -1) >= order) continue;
      session.fieldOrder.set(event.kind, order);
      if (event.kind === "camera") session.snapshot.camera = event.target;
      if (event.kind === "photo")
        session.snapshot.photoVisible = event.operation === "reveal";
      if (event.kind === "story") session.snapshot.storyNode = event.node;
    }
    if (
      record.completed.has(segment.segmentId) ||
      record.read.has(segment.segmentId)
    ) {
      const order = record.sequence * 100 + segmentIndex * 10;
      if ((session.fieldOrder.get("emotion") ?? -1) < order) {
        session.snapshot.emotion = segment.emotion;
        session.fieldOrder.set("emotion", order);
      }
    }
  }
}

export function getHistory(session: Session): HistoryEntry[] {
  return Array.from(session.turns.values())
    .filter((record) => record.input)
    .slice(-12)
    .map((record): HistoryEntry => ({
      input: record.input,
      reply:
        record.response?.segments
          .filter(
            (segment) =>
              record.completed.has(segment.segmentId) ||
              record.read.has(segment.segmentId),
          )
          .map((segment) => segment.text) ?? [],
      interrupted: record.interrupted,
      source:
        record.completed.size && record.read.size
          ? "mixed"
          : record.read.size
            ? "read"
            : "audio",
    }));
}
