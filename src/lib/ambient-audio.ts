import type { SceneState } from "../state/scene-reducer";

type AmbientScene = Pick<
  SceneState,
  "entered" | "loading" | "phase" | "micPending" | "recording" | "gate"
>;
type AmbientStatus = "off" | "loading" | "playing" | "paused" | "error";

export interface AmbientSnapshot {
  enabled: boolean;
  volume: number;
  status: AmbientStatus;
  message: string | null;
}

const STORAGE_KEY = "after-rain-ambience-v1";
const DEFAULT_VOLUME = 0.45;
const MUSIC_LEVEL = 0.35;
// Calibrated against the bundled recordings: the chime is about 3 dB above music.
const BELL_LEVEL = 0.42;
const MUSIC_PATH = "/assets/audio/cafe-music.mp3";
const BELL_PATH = "/assets/audio/furin-three-strikes.mp3";

function readPreferences(): Pick<AmbientSnapshot, "enabled" | "volume"> {
  const defaults = { enabled: true, volume: DEFAULT_VOLUME };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return defaults;
    return {
      enabled:
        "enabled" in value && typeof value.enabled === "boolean"
          ? value.enabled
          : defaults.enabled,
      volume:
        "volume" in value &&
        typeof value.volume === "number" &&
        Number.isFinite(value.volume)
          ? Math.max(0, Math.min(1, value.volume))
          : defaults.volume,
    };
  } catch (error) {
    console.warn("Ambience preferences unavailable", error);
    return defaults;
  }
}

export class AmbientAudio {
  private snapshot: AmbientSnapshot = {
    ...readPreferences(),
    status: "off",
    message: null,
  };
  private listeners = new Set<() => void>();
  private scene: AmbientScene = {
    entered: false,
    loading: false,
    phase: "idle",
    micPending: false,
    recording: false,
    gate: null,
  };
  private context: AudioContext | null = null;
  private musicGain: GainNode | null = null;
  private bellGain: GainNode | null = null;
  private musicBuffer: AudioBuffer | null = null;
  private bellBuffer: AudioBuffer | null = null;
  private musicSource: AudioBufferSourceNode | null = null;
  private bellSource: AudioBufferSourceNode | null = null;
  private musicOffset = 0;
  private musicStartedAt = 0;
  private bellTimer: ReturnType<typeof setTimeout> | null = null;
  private bellCount = 0;
  private entryBellPending = false;
  private generation = 0;
  private loader: AbortController | null = null;

  getSnapshot = (): AmbientSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  };

  private patch(update: Partial<AmbientSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    this.listeners.forEach((listener): void => {
      listener();
    });
  }

  private savePreferences(): void {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          enabled: this.snapshot.enabled,
          volume: this.snapshot.volume,
        }),
      );
    } catch (error) {
      console.warn("Ambience preferences could not be saved", error);
    }
  }

  private createContext(): AudioContext {
    if (this.context && this.context.state !== "closed") return this.context;
    const context = new AudioContext();
    this.context = context;
    this.musicGain = context.createGain();
    this.bellGain = context.createGain();
    this.musicGain.gain.value = 0;
    this.bellGain.gain.value = 0;
    this.musicGain.connect(context.destination);
    this.bellGain.connect(context.destination);
    context.onstatechange = (): void => {
      if (
        this.context !== context ||
        !this.snapshot.enabled ||
        this.snapshot.status === "loading"
      )
        return;
      if (context.state === "running" && this.musicBuffer) {
        this.patch({ status: "playing" });
        this.reconcile();
      } else if (this.snapshot.status === "playing") {
        this.patch({ status: "paused" });
      }
    };
    return context;
  }

  private async loadBuffer(
    context: AudioContext,
    path: string,
    signal: AbortSignal,
  ): Promise<AudioBuffer> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
    const response = await fetch(path, {
      signal: bounded,
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error(`Ambience asset failed: ${path}`);
    const bytes = await response.arrayBuffer();
    bounded.throwIfAborted();
    const buffer = await context.decodeAudioData(bytes);
    bounded.throwIfAborted();
    return buffer;
  }

  private resumeContext(context: AudioContext): Promise<void> {
    return new Promise((resolve, reject): void => {
      const timer = setTimeout((): void => {
        reject(new Error("Ambience playback permission timed out"));
      }, 12_000);
      void context.resume().then(
        (): void => {
          clearTimeout(timer);
          resolve();
        },
        (error: unknown): void => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  // Call directly from the entry/toggle gesture, before awaiting session creation.
  async unlock(): Promise<void> {
    if (!this.snapshot.enabled || this.snapshot.status === "loading") return;
    const generation = ++this.generation;
    this.loader?.abort();
    const loader = new AbortController();
    this.loader = loader;
    this.patch({ status: "loading", message: null });

    try {
      const context = this.createContext();
      const resumed = this.resumeContext(context);
      const [music, bell, playback] = await Promise.allSettled([
        this.musicBuffer
          ? Promise.resolve(this.musicBuffer)
          : this.loadBuffer(context, MUSIC_PATH, loader.signal),
        this.bellBuffer
          ? Promise.resolve(this.bellBuffer)
          : this.loadBuffer(context, BELL_PATH, loader.signal),
        resumed,
      ]);
      if (
        loader.signal.aborted ||
        generation !== this.generation ||
        this.context !== context
      )
        return;
      if (music.status === "rejected") throw music.reason;
      if (playback.status === "rejected") throw playback.reason;
      this.musicBuffer = music.value;
      this.bellBuffer = bell.status === "fulfilled" ? bell.value : null;
      if (bell.status === "rejected") {
        this.entryBellPending = false;
        console.warn(
          "Door bell unavailable; music remains available",
          bell.reason,
        );
      }
      this.patch({
        status: context.state === "running" ? "playing" : "paused",
        message:
          bell.status === "rejected"
            ? "门铃声暂不可用，背景音乐仍可播放。"
            : null,
      });
      this.reconcile();
    } catch (error) {
      if (loader.signal.aborted || generation !== this.generation) return;
      this.entryBellPending = false;
      console.warn("Ambience could not start", error);
      this.patch({
        status: "error",
        message: "氛围音暂时无法播放，可以重试；对话不受影响。",
      });
    } finally {
      if (generation === this.generation) this.loader = null;
    }
  }

  toggle(): void {
    if (this.snapshot.enabled) {
      this.entryBellPending = false;
      this.generation += 1;
      this.loader?.abort();
      this.loader = null;
      this.patch({ enabled: false, status: "off", message: null });
      this.reconcile();
    } else {
      this.patch({
        enabled: true,
        volume: this.snapshot.volume || DEFAULT_VOLUME,
      });
      void this.unlock();
    }
    this.savePreferences();
  }

  retry(): void {
    this.patch({ enabled: true });
    this.savePreferences();
    void this.unlock();
  }

  setVolume(value: number): void {
    if (!Number.isFinite(value)) return;
    if (value <= 0) this.entryBellPending = false;
    this.patch({ volume: Math.max(0, Math.min(1, value)) });
    this.savePreferences();
    this.reconcile();
  }

  syncScene(scene: AmbientScene): void {
    // Never replay a delayed entrance sound after conversation or a failed entry.
    if (
      scene.phase !== "idle" ||
      scene.micPending ||
      scene.recording ||
      scene.gate ||
      (this.scene.loading && !scene.loading && !scene.entered)
    )
      this.entryBellPending = false;
    this.scene = scene;
    this.reconcile();
  }

  queueEntryBell(): void {
    this.entryBellPending = this.snapshot.enabled && this.snapshot.volume > 0;
  }

  handleVisibility(): void {
    if (document.hidden) this.entryBellPending = false;
    this.reconcile();
    const context = this.context;
    if (!context || !this.snapshot.enabled || !this.scene.entered) return;
    const operation = document.hidden
      ? context.suspend()
      : this.resumeContext(context);
    void operation
      .then((): void => {
        if (this.context === context) this.reconcile();
      })
      .catch((error: unknown): void => {
        if (this.context !== context) return;
        console.warn("Ambience resume requires a gesture", error);
        this.patch({ status: "paused", message: "点击氛围音按钮继续播放。" });
      });
  }

  private setGain(
    node: GainNode | null,
    value: number,
    immediate: boolean,
  ): void {
    if (!node || !this.context) return;
    const now = this.context.currentTime;
    node.gain.cancelScheduledValues(now);
    if (immediate) node.gain.setValueAtTime(value, now);
    else
      node.gain.setTargetAtTime(
        value,
        now,
        value < node.gain.value ? 0.035 : 0.35,
      );
  }

  private canRing(): boolean {
    return (
      this.snapshot.enabled &&
      this.snapshot.volume > 0 &&
      this.scene.entered &&
      !this.scene.loading &&
      !this.scene.recording &&
      !this.scene.micPending &&
      this.scene.phase === "idle" &&
      !this.scene.gate &&
      !document.hidden
    );
  }

  private reconcile(): void {
    try {
      this.updateMix();
    } catch (error) {
      // Ambient failures must never escape into the dialogue controller's listeners.
      console.warn("Ambient mix unavailable", error);
      this.patch({
        status: "error",
        message: "氛围音暂时无法播放，可以重试；对话不受影响。",
      });
    }
  }

  private updateMix(): void {
    const context = this.context;
    if (!context) return;
    const active =
      this.snapshot.enabled &&
      this.scene.entered &&
      !this.scene.loading &&
      !document.hidden;
    const microphoneBusy =
      this.scene.recording ||
      this.scene.micPending ||
      this.scene.phase === "listening";
    const dialogueBusy =
      this.scene.phase === "speaking" ||
      this.scene.phase === "thinking" ||
      Boolean(this.scene.gate);
    const duck =
      this.scene.phase === "speaking" ? 0.18 : dialogueBusy ? 0.4 : 1;
    const level = active && !microphoneBusy ? this.snapshot.volume : 0;

    // This subscription runs synchronously before getUserMedia/start, not in a
    // later React effect. Recording must never capture our background mix.
    this.setGain(
      this.musicGain,
      level * MUSIC_LEVEL * duck,
      microphoneBusy || !active,
    );
    this.setGain(
      this.bellGain,
      this.canRing() ? level * BELL_LEVEL : 0,
      !this.canRing(),
    );
    if (!this.canRing()) this.stopBell();
    if (!active) {
      this.stopMusic();
      return;
    }
    if (context.state !== "running" || !this.musicBuffer || !this.musicGain)
      return;
    if (!this.musicSource) {
      const source = context.createBufferSource();
      source.buffer = this.musicBuffer;
      source.loop = true;
      source.connect(this.musicGain);
      this.musicStartedAt = context.currentTime;
      source.start(0, this.musicOffset % this.musicBuffer.duration);
      this.musicSource = source;
    }
    if (this.canRing()) {
      if (this.entryBellPending && this.bellBuffer) {
        this.entryBellPending = false;
        this.playBell();
      }
      this.scheduleBell();
    }
  }

  private playBell(): void {
    if (
      !this.canRing() ||
      !this.context ||
      !this.bellBuffer ||
      !this.bellGain ||
      this.context.state !== "running"
    )
      return;

    this.stopBell();
    const source = this.context.createBufferSource();
    source.buffer = this.bellBuffer;
    source.connect(this.bellGain);
    this.bellSource = source;
    source.onended = (): void => {
      source.disconnect();
      if (this.bellSource === source) this.bellSource = null;
    };
    // The asset has its own attack; a gain fade would hide the first chime.
    this.setGain(this.bellGain, this.snapshot.volume * BELL_LEVEL, true);
    source.start();
    this.bellCount += 1;
  }

  private scheduleBell(): void {
    if (this.bellTimer || !this.bellBuffer || !this.canRing()) return;
    const delay =
      this.bellCount === 0
        ? 16_000 + Math.random() * 10_000
        : 40_000 + Math.random() * 35_000;
    this.bellTimer = setTimeout((): void => {
      this.bellTimer = null;
      this.playBell();
      this.scheduleBell();
    }, delay);
  }

  private stopBell(): void {
    if (this.bellTimer) clearTimeout(this.bellTimer);
    this.bellTimer = null;
    const source = this.bellSource;
    this.bellSource = null;
    if (source) {
      source.stop();
      source.disconnect();
    }
  }

  private stopMusic(): void {
    const source = this.musicSource;
    if (!source) return;
    if (this.context && this.musicBuffer) {
      this.musicOffset =
        (this.musicOffset + this.context.currentTime - this.musicStartedAt) %
        this.musicBuffer.duration;
    }
    this.musicSource = null;
    source.stop();
    source.disconnect();
  }

  dispose(): void {
    this.entryBellPending = false;
    this.generation += 1;
    this.loader?.abort();
    this.loader = null;
    this.stopBell();
    this.stopMusic();
    const context = this.context;
    this.context = null;
    this.musicGain = null;
    this.bellGain = null;
    if (context) {
      context.onstatechange = null;
      void context.close().catch((error: unknown): void => {
        console.warn("Ambience cleanup failed", error);
      });
    }
    this.snapshot = { ...this.snapshot, status: "off", message: null };
    this.listeners.clear();
  }
}
