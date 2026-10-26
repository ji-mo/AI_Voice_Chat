const ASSET_TIMEOUT_MS = 10_000;

export function preloadSceneImage(
  path: string,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject): void => {
    const image = new Image();
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;

      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      image.onload = null;
      image.onerror = null;

      if (error) {
        image.removeAttribute("src");
        reject(error);
        return;
      }

      resolve();
    };

    const abort = (): void => {
      finish(new DOMException("Scene preload cancelled", "AbortError"));
    };

    // A missing image must reach the fallback UI instead of blocking entry forever.
    const timer = setTimeout((): void => {
      finish(new Error(`Scene image timed out: ${path}`));
    }, ASSET_TIMEOUT_MS);

    if (signal.aborted) {
      abort();
      return;
    }

    signal.addEventListener("abort", abort, { once: true });
    image.onerror = (): void => {
      finish(new Error(`Scene image failed: ${path}`));
    };
    image.onload = (): void => {
      void image.decode().then(
        (): void => {
          finish();
        },
        (): void => {
          finish(new Error(`Scene image could not be decoded: ${path}`));
        },
      );
    };
    image.src = path;
  });
}
