import type {
  AppMode,
  CancelReason,
  DemoFault,
  HealthResponse,
  PlaybackReceipt,
  RenderableSegment,
  SceneEvent,
  TurnIdentity,
  TurnResponse,
} from "../../shared/contracts";
import { api, ApiFailure } from "./api";
import { AudioPlayer } from "./audio-player";
import { Recorder } from "./recorder";
import { SceneDirector } from "./scene-director";
import {
  applySceneEvent,
  initialState,
  type SceneState,
} from "../state/scene-reducer";

function copyReceipt(receipt: PlaybackReceipt | null): PlaybackReceipt | null {
  return receipt ? structuredClone(receipt) : null;
}

function audioFallbackMessage(warnings: readonly string[]): string {
  const reasons: Record<string, string> = {
    BAILIAN_MODEL_UNAVAILABLE:
      "当前百炼语音模型不可用，请检查模型配置或开通状态。",
    BAILIAN_CONFIGURATION: "百炼语音配置未被接受，请检查模型和音色。",
    BAILIAN_AUTH: "百炼语音鉴权失败，请检查密钥及地域。",
    BAILIAN_ACCESS: "当前账号暂无此语音模型的访问权限。",
    BAILIAN_QUOTA: "百炼语音可用额度不足。",
    BAILIAN_RATE_LIMIT: "百炼语音调用暂时受限，请稍后重试。",
    TTS_TIMEOUT: "语音生成超时，请稍后重试。",
    BAILIAN_AUDIO_FORMAT: "语音文件格式异常，请重试。",
    BAILIAN_AUDIO_DOWNLOAD: "语音下载失败，请检查网络后重试。",
  };
  for (const warning of warnings) {
    if (!warning.startsWith("AUDIO_UNAVAILABLE:")) continue;
    const reason = reasons[warning.slice("AUDIO_UNAVAILABLE:".length)];
    if (reason) return `${reason}你可以先阅读回复。`;
  }
  return "语音暂不可用，可以继续阅读，也可以重新提问。";
}

export class SessionController {
  private state: SceneState = {
    ...initialState,
    snapshot: { ...initialState.snapshot },
  };
  private listeners = new Set<() => void>();
  private sessionId = "";
  private sequence = 0;
  // Session resets and turn cancellation have separate generations.
  private lifecycle = 0;
  private availabilityRequest = 0;
  private availabilityAborter: AbortController | null = null;
  private identity: TurnIdentity | null = null;
  private aborter: AbortController | null = null;
  private receipt: PlaybackReceipt | null = null;
  private previousReceipt: PlaybackReceipt | null = null;
  private recordingIntent = false;
  private recorder = new Recorder();
  private photoAvailable = true;
  private lastInputKind: "text" | "voice" = "text";
  private player: AudioPlayer;
  private director: SceneDirector;

  constructor() {
    this.director = new SceneDirector(
      (identity) => this.isCurrent(identity),
      (event) => this.applyEvent(event),
    );
    this.player = new AudioPlayer({
      onStart: (segment, source, receipt): void => {
        if (this.identity?.turnId !== receipt.turnId) return;
        this.patch({
          phase: source === "audio" ? "speaking" : "idle",
          subtitle: segment.text,
          action: segment.action,
          snapshot: { ...this.state.snapshot, emotion: segment.emotion },
        });
        this.applyEvents(segment, "segment_start", receipt);
      },
      onEnd: (segment, receipt): void => {
        if (this.identity?.turnId !== receipt.turnId) return;
        this.applyEvents(segment, "segment_end", receipt);
        this.sendReceipt(receipt);
      },
      onGate: (gate): void => {
        this.patch({ gate, phase: "idle" });
      },
      onBuffer: (): void => {
        this.patch({ phase: "thinking", action: "none" });
      },
      onFallback: (warnings): void => {
        this.patch({
          phase: "idle",
          notice: {
            kind: "info",
            message: audioFallbackMessage(warnings),
          },
        });
      },
    });
  }

  getSnapshot = (): SceneState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  };

  private patch(update: Partial<SceneState>): void {
    this.state = { ...this.state, ...update };
    this.listeners.forEach((listener): void => {
      listener();
    });
  }

  private isCurrent(identity: TurnIdentity): boolean {
    return (
      this.identity?.turnId === identity.turnId &&
      this.sessionId === identity.sessionId &&
      this.sequence === identity.turnSeq
    );
  }

  setPhotoAvailable(available: boolean): void {
    this.photoAvailable = available;
  }

  setFault(fault: DemoFault | ""): void {
    this.patch({ fault });
  }

  clearNotice(): void {
    this.patch({ notice: null });
  }

  async refreshAvailability(): Promise<HealthResponse | null> {
    const request = ++this.availabilityRequest;
    this.availabilityAborter?.abort();
    const aborter = new AbortController();
    this.availabilityAborter = aborter;
    this.patch({ availabilityStatus: "loading", availabilityError: null });
    try {
      const health = await api.health(aborter.signal);
      if (aborter.signal.aborted || request !== this.availabilityRequest)
        return null;
      this.patch({
        availableModes: health.availableModes,
        availabilityStatus: "ready",
        availabilityError: null,
        ...(!this.state.entered && !this.state.loading
          ? { mode: health.mode }
          : {}),
      });
      return health;
    } catch (error) {
      if (aborter.signal.aborted || request !== this.availabilityRequest)
        return null;
      this.patch({
        availabilityStatus: "error",
        availabilityError: this.message(error),
      });
      return null;
    } finally {
      if (request === this.availabilityRequest) this.availabilityAborter = null;
    }
  }

  async connect(mode?: AppMode): Promise<void> {
    const lifecycle = ++this.lifecycle;
    const previousMode = this.state.mode;
    this.cancelActiveTurn("session_reset");
    this.patch({ loading: true, notice: null, entered: false });
    const previous = this.sessionId;
    this.sessionId = "";
    try {
      if (previous)
        await api.deleteSession(previous).catch((error: unknown): void => {
          console.warn(
            "Previous session cleanup failed",
            error instanceof Error ? error.name : "Unknown",
          );
        });
      if (lifecycle !== this.lifecycle) return;
      const health = await this.refreshAvailability();
      if (lifecycle !== this.lifecycle) return;
      if (!health)
        throw new ApiFailure(
          "AVAILABILITY",
          this.state.availabilityError ?? "暂时无法检查服务配置，请重试。",
          true,
        );
      const selectedMode = mode ?? (previous ? previousMode : health.mode);
      if (!health.availableModes.includes(selectedMode)) {
        throw new ApiFailure(
          "LIVE_UNAVAILABLE",
          "真实对话尚未启用，请检查服务配置后重试。",
          false,
        );
      }
      const session = await api.createSession(selectedMode);
      if (lifecycle !== this.lifecycle) {
        // A superseded connection can still create a server-side session.
        void api
          .deleteSession(session.sessionId)
          .catch((error: unknown): void => {
            console.warn(
              "Superseded session cleanup failed",
              error instanceof Error ? error.name : "Unknown",
            );
          });
        return;
      }
      this.sessionId = session.sessionId;
      this.sequence = 0;
      this.receipt = null;
      this.previousReceipt = null;
      this.patch({
        entered: true,
        loading: false,
        mode: session.mode,
        availableModes: health.availableModes,
        demoFaults: session.demoFaults,
        snapshot: session.snapshot,
        subtitle: "",
        inputText: "",
        action: "none",
        phase: "idle",
        fault: "",
      });
    } catch (error) {
      if (lifecycle === this.lifecycle)
        this.patch({
          loading: false,
          notice: { kind: "error", message: this.message(error) },
        });
    }
  }

  cancelActiveTurn(_reason: CancelReason): void {
    const oldIdentity = this.identity;
    // Invalidate identity before stopping resources; their callbacks may still arrive.
    this.identity = null;
    this.sequence += 1;
    this.aborter?.abort();
    this.aborter = null;
    this.player.stop();
    this.recordingIntent = false;
    this.recorder.dispose();
    if (oldIdentity) this.director.cancelTurn(oldIdentity);
    this.patch({
      phase: "idle",
      action: "none",
      gate: null,
      subtitle: "",
      recording: false,
      micPending: false,
      notice: null,
    });
    if (this.sessionId) {
      api
        .interrupt(this.sessionId, this.sequence, copyReceipt(this.receipt))
        .catch((error: unknown): void => {
          console.warn(
            "Interrupt acknowledgement failed; local turn remains invalid",
            error instanceof Error ? error.name : "Unknown",
          );
        });
    }
  }

  beginIntent(kind: "text" | "voice"): TurnIdentity {
    this.cancelActiveTurn("new_input");
    const identity = {
      sessionId: this.sessionId,
      turnId: crypto.randomUUID(),
      turnSeq: this.sequence,
    };
    this.identity = identity;
    this.aborter = new AbortController();
    this.previousReceipt = copyReceipt(this.receipt);
    this.lastInputKind = kind;
    this.patch({ notice: null });
    return identity;
  }

  async sendText(value: string): Promise<void> {
    const text = value.trim();
    if (!text || text.length > 500) {
      this.patch({
        notice: {
          kind: "info",
          message: text
            ? "请把这段话缩短到 500 字以内。"
            : "写下一句话，再发送给 Mira。",
        },
      });
      return;
    }
    if (!this.sessionId) return;
    const identity = this.beginIntent("text");
    const signal = this.aborter?.signal;
    if (!signal) return;
    this.patch({ inputText: text, phase: "thinking" });
    const fault = this.state.fault || undefined;
    this.patch({ fault: "" });
    await this.receive(
      identity,
      signal,
      api.text(identity, text, this.previousReceipt, fault, signal),
    );
  }

  private async receive(
    identity: TurnIdentity,
    signal: AbortSignal,
    response: Promise<TurnResponse>,
  ): Promise<void> {
    try {
      const reply = await response;
      // Abort alone is insufficient when a response has already reached the client.
      if (!this.isCurrent(identity) || signal.aborted) return;
      if (
        reply.sessionId !== identity.sessionId ||
        reply.turnId !== identity.turnId ||
        reply.turnSeq !== identity.turnSeq
      )
        throw new ApiFailure("PROTOCOL", "收到不匹配的回应，请重试。", true);
      this.patch({ inputText: reply.inputText });
      const receipt: PlaybackReceipt = {
        turnId: reply.turnId,
        completedSegmentIds: [],
        readSegmentIds: [],
        appliedEventIds: [],
      };
      this.receipt = receipt;
      await this.player.playReply(reply, signal, receipt);
      if (this.isCurrent(identity))
        this.patch({ phase: "idle", action: "none", gate: null });
    } catch (error) {
      if (!this.isCurrent(identity) || signal.aborted) return;
      if (error instanceof ApiFailure && error.code === "SESSION_EXPIRED")
        this.patch({ entered: false });
      this.patch({
        phase: "idle",
        action: "none",
        gate: null,
        notice: { kind: "error", message: this.message(error) },
      });
    }
  }

  retryInput(): void {
    if (!this.state.entered) {
      void this.connect();
      return;
    }
    if (this.lastInputKind === "voice") {
      this.patch({
        notice: {
          kind: "info",
          message:
            "请重新按住麦克风说话，或使用示例语音。上一段录音不会被重复发送。",
        },
      });
      return;
    }
    if (this.state.inputText) void this.sendText(this.state.inputText);
  }

  resumePlayback(): void {
    this.player.resume();
  }

  async sendExampleVoice(): Promise<void> {
    if (!this.sessionId || this.state.mode !== "mock") return;
    const identity = this.beginIntent("voice");
    const signal = this.aborter?.signal;
    if (!signal) return;
    this.patch({
      phase: "thinking",
      notice: {
        kind: "info",
        message: "正在使用示例录音。演示模式采用预设转写，不识别任意语音。",
      },
    });
    const fault = this.state.fault || undefined;
    this.patch({ fault: "" });
    const response = api
      .exampleAudio(identity.sessionId, signal)
      .then((audio) =>
        api.voice(identity, audio, this.previousReceipt, fault, signal),
      );
    await this.receive(identity, signal, response);
  }

  async startVoice(): Promise<void> {
    if (!this.sessionId || this.recordingIntent) return;
    const identity = this.beginIntent("voice");
    this.recordingIntent = true;
    this.patch({
      micPending: true,
      notice: this.state.micReady
        ? null
        : { kind: "info", message: "请在浏览器中允许麦克风访问。" },
    });
    try {
      const started = await this.recorder.start((): void => {
        void this.stopVoice();
      });
      if (started && this.isCurrent(identity) && this.recordingIntent)
        this.patch({
          micReady: true,
          recording: true,
          micPending: false,
          phase: "listening",
          notice: null,
        });
    } catch (error) {
      if (!this.isCurrent(identity) || !this.recordingIntent) return;
      this.recordingIntent = false;
      this.patch({
        recording: false,
        micPending: false,
        micReady: false,
        phase: "idle",
        notice: { kind: "error", message: this.micMessage(error) },
      });
    }
  }

  async stopVoice(): Promise<void> {
    if (!this.recordingIntent) return;
    // Consume this intent synchronously. A later recording owns a different
    // identity and must not wait for this recorder's asynchronous stop event.
    this.recordingIntent = false;
    const identity = this.identity;
    const signal = this.aborter?.signal;
    this.patch({ recording: false, micPending: false, phase: "idle" });
    try {
      const recorded = await this.recorder.stop();
      if (!identity || !signal || !this.isCurrent(identity)) return;
      if (!recorded || recorded.durationMs < 300 || recorded.blob.size < 100) {
        this.patch({
          notice: { kind: "info", message: "录音太短，请按住按钮说完一句话。" },
        });
        return;
      }
      this.patch({ phase: "thinking" });
      const fault = this.state.fault || undefined;
      this.patch({ fault: "" });
      await this.receive(
        identity,
        signal,
        api.voice(identity, recorded.blob, this.previousReceipt, fault, signal),
      );
    } catch (error) {
      if (identity && this.isCurrent(identity))
        this.patch({
          phase: "idle",
          recording: false,
          micPending: false,
          notice: { kind: "error", message: this.micMessage(error) },
        });
    }
  }

  private applyEvent(event: SceneEvent): boolean {
    if (
      event.kind === "photo" &&
      event.operation === "reveal" &&
      !this.photoAvailable
    ) {
      this.patch({
        notice: {
          kind: "info",
          message: "照片暂时没有加载出来，我们可以继续聊。",
        },
      });
      return false;
    }
    if (
      event.kind === "story" &&
      event.node === "photo_revealed" &&
      !this.state.snapshot.photoVisible
    )
      return false;
    this.patch({ snapshot: applySceneEvent(this.state.snapshot, event) });
    return true;
  }

  private applyEvents(
    segment: RenderableSegment,
    trigger: "segment_start" | "segment_end",
    receipt: PlaybackReceipt,
  ): void {
    if (!this.identity) return;
    for (const event of segment.events)
      if (
        event.trigger === trigger &&
        this.director.applyEvent(event, this.identity)
      )
        receipt.appliedEventIds.push(event.eventId);
    this.sendReceipt(receipt);
  }

  private sendReceipt(receipt: PlaybackReceipt): void {
    api
      .playback(this.sessionId, structuredClone(receipt))
      .catch((error: unknown): void => {
        console.warn(
          "Playback receipt will be included in the next request",
          error instanceof Error ? error.name : "Unknown",
        );
      });
  }

  private message(error: unknown): string {
    return error instanceof Error
      ? error.message
      : "出了点小问题，请重新尝试。";
  }

  private micMessage(error: unknown): string {
    if (error instanceof DOMException && error.name === "NotAllowedError")
      return "麦克风权限被拒绝。请在浏览器设置中允许访问，或继续使用文字。";
    if (error instanceof DOMException && error.name === "NotFoundError")
      return "没有找到麦克风，可以先使用文字交流。";
    return this.message(error);
  }

  dispose(): void {
    this.availabilityRequest += 1;
    this.availabilityAborter?.abort();
    this.availabilityAborter = null;
    this.lifecycle += 1;
    this.cancelActiveTurn("unmount");
    this.listeners.clear();
  }
}
