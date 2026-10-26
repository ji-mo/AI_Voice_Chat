export type AppMode = "mock" | "live";

export type CharacterPhase = "idle" | "listening" | "thinking" | "speaking";

export type Emotion = "neutral" | "curious" | "warm";

export type Action = "none" | "look_window" | "show_photo";

export type StoryNode =
  "arrival" | "conversation" | "photo_revealed" | "farewell";

export type DemoFault = "delay_reply" | "model_timeout" | "audio_failure";

export type CancelReason =
  "new_input" | "user_cancel" | "session_reset" | "page_hidden" | "unmount";

interface CameraEvent {
  kind: "camera";
  trigger: "segment_start";
  target: "table" | "window";
}

interface PhotoEvent {
  kind: "photo";
  trigger: "segment_start";
  operation: "reveal" | "hide";
  assetId: "lighthouse_photo";
}

interface StoryEvent {
  kind: "story";
  trigger: "segment_end";
  node: StoryNode;
}

export type ModelSceneEvent = CameraEvent | PhotoEvent | StoryEvent;

export type SceneEvent = ModelSceneEvent & { eventId: string };

export interface ReplySegment {
  text: string;
  emotion: Emotion;
  action: Action;
  events: ModelSceneEvent[];
}

export interface CharacterReply {
  segments: ReplySegment[];
}

export interface AudioAsset {
  audioId: string;
  url: string;
  mimeType: string;
}

export interface RenderableSegment extends Omit<ReplySegment, "events"> {
  segmentId: string;
  events: SceneEvent[];
  audio: AudioAsset | null;
}

export interface TurnIdentity {
  sessionId: string;
  turnId: string;
  turnSeq: number;
}

export interface TurnResponse extends TurnIdentity {
  mode: AppMode;
  inputText: string;
  segments: RenderableSegment[];
  warnings: string[];
}

export interface PlaybackReceipt {
  turnId: string;
  completedSegmentIds: string[];
  readSegmentIds: string[];
  appliedEventIds: string[];
}

export interface SceneSnapshot {
  storyNode: StoryNode;
  camera: "table" | "window";
  photoVisible: boolean;
  emotion: Emotion;
}

export interface SessionResponse {
  sessionId: string;
  snapshot: SceneSnapshot;
  mode: AppMode;
  demoFaults: boolean;
}

export interface HealthResponse {
  status: "ok";
  mode: AppMode;
  availableModes: AppMode[];
}

export interface ApiError {
  code: string;
  message: string;
  retryable: boolean;
  turnId: string | null;
}

export interface TurnRequest {
  turnId: string;
  turnSeq: number;
  text: string;
  previousReceipt: PlaybackReceipt | null;
  demoFault?: DemoFault;
}

export interface HistoryEntry {
  input: string;
  reply: string[];
  interrupted: boolean;
  source: "audio" | "read" | "mixed";
}

export interface DialogueContext {
  text: string;
  history: HistoryEntry[];
  snapshot: SceneSnapshot;
}

export const initialSnapshot: SceneSnapshot = {
  storyNode: "arrival",
  camera: "table",
  photoVisible: false,
  emotion: "neutral",
};
