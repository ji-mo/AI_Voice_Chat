export interface RecordedAudio {
  blob: Blob;
  mimeType: string;
  durationMs: number;
}

export class Recorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private result: Promise<RecordedAudio | null> | null = null;
  private discard = false;

  async start(onLimit: () => void): Promise<boolean> {
    this.dispose();
    if (
      !window.isSecureContext ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    )
      throw new Error(
        "当前浏览器无法录音。请使用 HTTPS 或本机 localhost，或改用文字。",
      );
    const generation = this.generation;
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(
      (format) => MediaRecorder.isTypeSupported(format),
    );
    if (!mime) throw new Error("浏览器录音格式暂不支持，请改用文字。");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    if (generation !== this.generation) {
      stream.getTracks().forEach((track): void => {
        track.stop();
      });
      return false;
    }
    this.stream = stream;
    this.discard = false;

    try {
      const recorder = new MediaRecorder(stream, {
        mimeType: mime,
        audioBitsPerSecond: 64_000,
      });
      this.recorder = recorder;
      const chunks: BlobPart[] = [];
      let size = 0;
      const started = performance.now();

      this.result = new Promise((resolve, reject): void => {
        recorder.ondataavailable = (event): void => {
          if (event.data.size) {
            chunks.push(event.data);
            size += event.data.size;
          }
          if (size > 5 * 1024 * 1024 && recorder.state === "recording") {
            this.discard = true;
            onLimit();
          }
        };
        recorder.onstop = (): void => {
          const blob = new Blob(chunks, { type: recorder.mimeType });
          const result =
            generation !== this.generation ||
            this.discard ||
            size > 5 * 1024 * 1024
              ? null
              : {
                  blob,
                  mimeType: recorder.mimeType,
                  durationMs: performance.now() - started,
                };
          stream.getTracks().forEach((track): void => {
            track.stop();
          });
          if (this.recorder === recorder) this.releaseTracks();
          resolve(result);
        };
        recorder.onerror = (): void => {
          stream.getTracks().forEach((track): void => {
            track.stop();
          });
          if (this.recorder === recorder) this.releaseTracks();
          reject(new Error("录音中断，请检查麦克风后再试。"));
          if (generation === this.generation) onLimit();
        };
      });

      this.result.catch((error: unknown): void => {
        console.warn(
          "Recording failed",
          error instanceof Error ? error.message : "Unknown recording error",
        );
      });

      recorder.start(250);
      this.timer = setTimeout(onLimit, 30_000);
      return true;
    } catch (error) {
      // Construction and start can fail after getUserMedia has opened the device.
      this.dispose();
      throw error;
    }
  }

  async stop(): Promise<RecordedAudio | null> {
    const result = this.result;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.recorder?.state === "recording") this.recorder.stop();
    else if (!this.recorder) {
      this.generation += 1;
      this.releaseTracks();
    }
    return result ? await result : null;
  }

  private releaseTracks(): void {
    this.stream?.getTracks().forEach((track): void => {
      track.stop();
    });
    this.stream = null;
    this.recorder = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.generation += 1;
    this.discard = true;
    if (this.recorder?.state === "recording") this.recorder.stop();
    this.releaseTracks();
    this.result = null;
  }
}
