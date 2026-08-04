import type { EdgeAdminEvent } from "@simplewatch/contracts";

type EventType = EdgeAdminEvent["type"];

export class AdminEventHub {
  private revision = 0;
  private readonly listeners = new Set<(event: EdgeAdminEvent) => void>();

  public constructor(private readonly now: () => number = Date.now) {}

  public publish(type: EventType, entityId: string | null = null): void {
    this.revision += 1;
    const event: EdgeAdminEvent = {
      id: String(this.revision),
      type,
      entityId,
      revision: this.revision,
      occurredAt: new Date(this.now()).toISOString(),
    };
    for (const listener of [...this.listeners]) listener(event);
  }

  public subscribe(listener: (event: EdgeAdminEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
