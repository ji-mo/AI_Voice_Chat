import type { SceneEvent, TurnIdentity } from "../../shared/contracts";

export class SceneDirector {
  private applied = new Set<string>();

  constructor(
    private isCurrent: (identity: TurnIdentity) => boolean,
    private apply: (event: SceneEvent) => boolean,
  ) {}

  applyEvent(event: SceneEvent, identity: TurnIdentity): boolean {
    if (!this.isCurrent(identity) || this.applied.has(event.eventId))
      return false;
    if (!this.apply(event)) return false;
    this.applied.add(event.eventId);
    return true;
  }

  cancelTurn(_identity: TurnIdentity): void {
    this.applied.clear();
  }
}
