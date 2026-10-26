import type {
  PlaybackReceipt,
  RenderableSegment,
  TurnResponse,
} from "../../shared/contracts";
import type { PlayerGate } from "../state/scene-reducer";

interface PlaybackCallbacks {
  onStart: (
    segment: RenderableSegment,
    source: "audio" | "read",
    receipt: PlaybackReceipt,
  ) => void;
  onEnd: (segment: RenderableSegment, receipt: PlaybackReceipt) => void;
  onGate: (gate: PlayerGate) => void;
  onBuffer: () => void;
  onFallback: (warnings: readonly string[]) => void;
}

export class AudioPlayer {
  private audio = new Audio();
  private resumeAction: (() => void) | null = null;
  private cleanup: (() => void) | null = null;

  constructor(private callbacks: PlaybackCallbacks) {
    this.audio.preload = "auto";
  }

  resume(): void {
    this.resumeAction?.();
  }

  stop(): void {
    this.cleanup?.();
    this.cleanup = null;
    this.resumeAction = null;
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
  }

  private waitForRead(gate: PlayerGate, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject): void => {
      const abort = (): void => {
        finish();
        reject(new DOMException("Cancelled", "AbortError"));
      };
      const finish = (): void => {
        signal.removeEventListener("abort", abort);
        this.resumeAction = null;
        this.cleanup = null;
      };
      this.cleanup = abort;
      this.resumeAction = (): void => {
        finish();
        this.callbacks.onGate(null);
        resolve();
      };
      signal.addEventListener("abort", abort, { once: true });
      this.callbacks.onGate(gate);
      if (signal.aborted) abort();
    });
  }

  private playSegment(
    segment: RenderableSegment,
    receipt: PlaybackReceipt,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject): void => {
      if (!segment.audio) {
        reject(new Error("Audio unavailable"));
        return;
      }
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        clearTimeout(timer);
        this.audio.onplaying = null;
        this.audio.onended = null;
        this.audio.onerror = null;
        this.audio.onwaiting = null;
        signal.removeEventListener("abort", abort);
        this.resumeAction = null;
        this.cleanup = null;
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this.audio.pause();
        reject(error);
      };
      const abort = (): void => {
        fail(new DOMException("Cancelled", "AbortError"));
      };
      const armTimeout = (): void => {
        clearTimeout(timer);
        timer = setTimeout((): void => {
          fail(new Error("Audio load timed out"));
        }, 15_000);
      };
      const attempt = (): void => {
        if (signal.aborted) {
          abort();
          return;
        }
        this.callbacks.onGate(null);
        armTimeout();
        this.audio.play().catch((error: unknown): void => {
          if (settled || signal.aborted) return;
          if (
            error instanceof DOMException &&
            error.name === "NotAllowedError"
          ) {
            clearTimeout(timer);
            this.resumeAction = attempt;
            this.callbacks.onGate("blocked");
          } else
            fail(
              error instanceof Error
                ? error
                : new Error("Audio playback failed"),
            );
        });
      };
      this.audio.onplaying = (): void => {
        if (signal.aborted) {
          abort();
          return;
        }
        clearTimeout(timer);
        this.callbacks.onStart(segment, "audio", receipt);
      };
      this.audio.onwaiting = (): void => {
        this.callbacks.onBuffer();
        armTimeout();
      };
      this.audio.onended = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      this.audio.onerror = (): void => {
        fail(new Error("Audio failed to load"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.cleanup = abort;
      this.audio.src = segment.audio.url;
      attempt();
    });
  }

  async playReply(
    reply: TurnResponse,
    signal: AbortSignal,
    receipt: PlaybackReceipt,
  ): Promise<PlaybackReceipt> {
    // Only audible or explicitly read segments become committed conversation history.
    for (const segment of reply.segments) {
      signal.throwIfAborted();
      this.callbacks.onBuffer();
      try {
        await this.playSegment(segment, receipt, signal);
        signal.throwIfAborted();
        receipt.completedSegmentIds.push(segment.segmentId);
      } catch (error) {
        if (signal.aborted) throw error;
        this.callbacks.onFallback(reply.warnings);
        await this.waitForRead("read_start", signal);
        this.callbacks.onStart(segment, "read", receipt);
        await this.waitForRead("read_next", signal);
        receipt.readSegmentIds.push(segment.segmentId);
      }
      this.callbacks.onEnd(segment, receipt);
    }
    return receipt;
  }
}
