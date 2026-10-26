import type {
  Action,
  AppMode,
  CharacterPhase,
  DemoFault,
  SceneEvent,
  SceneSnapshot,
} from "../../shared/contracts";
import { initialSnapshot } from "../../shared/contracts";

export interface Notice {
  kind: "info" | "error";
  message: string;
}

export type PlayerGate = "blocked" | "read_start" | "read_next" | null;

export interface SceneState {
  entered: boolean;
  loading: boolean;
  mode: AppMode;
  availableModes: AppMode[];
  availabilityStatus: "loading" | "ready" | "error";
  availabilityError: string | null;
  demoFaults: boolean;
  fault: DemoFault | "";
  phase: CharacterPhase;
  snapshot: SceneSnapshot;
  action: Action;
  subtitle: string;
  inputText: string;
  notice: Notice | null;
  gate: PlayerGate;
  micReady: boolean;
  micPending: boolean;
  recording: boolean;
}

export const initialState: SceneState = {
  entered: false,
  loading: false,
  mode: "mock",
  availableModes: ["mock"],
  availabilityStatus: "loading",
  availabilityError: null,
  demoFaults: false,
  fault: "",
  phase: "idle",
  snapshot: { ...initialSnapshot },
  action: "none",
  subtitle: "",
  inputText: "",
  notice: null,
  gate: null,
  micReady: false,
  micPending: false,
  recording: false,
};

export function applySceneEvent(
  snapshot: SceneSnapshot,
  event: SceneEvent,
): SceneSnapshot {
  if (event.kind === "camera") return { ...snapshot, camera: event.target };
  if (event.kind === "photo")
    return { ...snapshot, photoVisible: event.operation === "reveal" };
  return { ...snapshot, storyNode: event.node };
}
