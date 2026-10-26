export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}

export function assertActive(signal: AbortSignal): void {
  if (signal.aborted)
    throw new AppError(409, "CANCELLED", "这轮回复已经停止。");
}

export function logStage(
  turnId: string,
  stage: string,
  durationMs: number,
  outcome: string,
): void {
  console.info(
    JSON.stringify({
      turnId,
      stage,
      durationMs: Math.round(durationMs),
      outcome,
    }),
  );
}
