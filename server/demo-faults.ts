import { setTimeout as delay } from "node:timers/promises";
import type { AppMode, DemoFault } from "../shared/contracts";
import { config } from "./config";
import { AppError } from "./errors";

export function validateFault(mode: AppMode, fault?: DemoFault): void {
  if (fault && (mode !== "mock" || !config.demoFaults))
    throw new AppError(400, "FAULT_DISABLED", "当前会话未开启演示故障。");
}

export async function applyDemoFault(
  fault: DemoFault | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (fault === "delay_reply") await delay(8000, undefined, { signal });
  if (fault === "model_timeout")
    throw new AppError(
      504,
      "MODEL_TIMEOUT",
      "回应等待超时，请重试或换个话题。",
      true,
    );
}
