import type { RoomCommandRequest } from "@simplewatch/contracts";

export interface RoomCommandContext {
  readonly roomId: string;
  readonly mediaId: string | null;
  readonly generation: number;
}

export interface RoomCommandResult {
  readonly commandId: string;
  readonly context: RoomCommandContext;
  readonly outcome:
    | "applied"
    | "rejected"
    | "unknown"
    | "superseded"
    | "cancelled";
  readonly reason?: string;
  readonly executionRevision?: number;
  readonly currentRevision?: number;
}

export interface RoomCommandQueueOptions {
  /** Monotonic clock, not the server/wall clock. */
  readonly nowMs: () => number;
  readonly serverNowMs?: () => number;
  readonly createId: () => string;
  /** Return false when the transport cannot send. Retries retain the exact request. */
  readonly send: (
    request: RoomCommandRequest,
    context: RoomCommandContext,
  ) => boolean | void;
  readonly onRefresh: () => void;
  readonly onResult?: (result: RoomCommandResult) => void;
  readonly onChange?: () => void;
}

interface QueuedCommand {
  readonly commandId: string;
  readonly command: RoomCommandRequest["command"];
  readonly context: RoomCommandContext;
}

interface InFlightCommand extends QueuedCommand {
  readonly request: RoomCommandRequest;
  readonly sentAtMs: number;
  retried: boolean;
}

/** Serializes host writes; a pending seek can only replace an adjacent pending seek. */
export class RoomCommandQueue {
  private context: RoomCommandContext | null = null;
  private revision = 0;
  private pending: QueuedCommand[] = [];
  private inFlight: InFlightCommand | null = null;
  private frozen = false;
  private uncertain = new Map<string, QueuedCommand>();

  public constructor(private readonly options: RoomCommandQueueOptions) {}

  public setContext(context: RoomCommandContext, revision: number): void {
    if (this.context && sameContext(this.context, context)) {
      this.updateRevision(revision);
      return;
    }
    const previousRevision =
      this.context?.roomId === context.roomId ? this.revision : 0;
    this.reset();
    this.context = { ...context };
    this.revision = Math.max(previousRevision, revision);
  }

  public updateRevision(revision: number): void {
    this.revision = Math.max(this.revision, revision);
  }

  /** Only call for a freshly requested authoritative snapshot, not a cached
   * snapshot or command receipt. The caller also fences its connection epoch. */
  public acceptAuthoritativeSnapshot(
    context: RoomCommandContext,
    revision: number,
  ): boolean {
    if (
      !this.context ||
      !sameContext(this.context, context) ||
      revision < this.revision
    )
      return false;
    this.updateRevision(revision);
    this.frozen = false;
    this.options.onChange?.();
    return true;
  }

  public enqueue(command: RoomCommandRequest["command"]): string | null {
    if (!this.context || this.frozen) return null;
    const queued: QueuedCommand = {
      commandId: this.options.createId(),
      command: { ...command },
      context: { ...this.context },
    };
    const previous = this.pending.at(-1);
    if (command.kind === "seek" && previous?.command.kind === "seek") {
      this.pending.pop();
      this.result(previous, "superseded");
    }
    this.pending.push(queued);
    this.pump();
    this.options.onChange?.();
    return queued.commandId;
  }

  public acknowledge(
    commandId: string,
    executionRevision: number,
    currentRevision = executionRevision,
  ): boolean {
    const current = this.inFlight;
    if (!current || current.commandId !== commandId) {
      const uncertain = this.uncertain.get(commandId);
      if (!uncertain) return false;
      this.uncertain.delete(commandId);
      // A late receipt describes the old execution, not a fresh authoritative
      // snapshot. It must never release the freeze or revive cancelled work.
      this.result(
        uncertain,
        "applied",
        undefined,
        executionRevision,
        this.revision,
      );
      return true;
    }
    this.inFlight = null;
    this.updateRevision(currentRevision);
    this.result(
      current,
      "applied",
      undefined,
      executionRevision,
      this.revision,
    );
    this.pump();
    this.options.onChange?.();
    return true;
  }

  public reject(commandId: string, reason: string): boolean {
    const current = this.inFlight;
    if (!current || current.commandId !== commandId) return false;
    this.fail(current, "rejected", reason);
    return true;
  }

  public tick(): void {
    const current = this.inFlight;
    if (!current) return;
    const elapsed = this.options.nowMs() - current.sentAtMs;
    if (elapsed >= 10_000) {
      this.fail(current, "unknown", "command-confirmation-timeout");
      return;
    }
    if (elapsed >= 3_000 && !current.retried) {
      current.retried = true;
      // A temporary disconnection during the retry does not prove the first
      // request failed. Keep waiting for its receipt until the original deadline.
      try {
        this.options.send(current.request, current.context);
      } catch {
        // Outcome remains unknown; never replay under a new command ID.
      }
    }
  }

  public reset(): void {
    const discarded = [
      ...(this.inFlight ? [this.inFlight] : []),
      ...this.pending,
    ];
    this.inFlight = null;
    this.pending = [];
    this.context = null;
    this.revision = 0;
    this.frozen = false;
    this.uncertain.clear();
    for (const command of discarded)
      this.result(command, "cancelled", "context-changed");
    this.options.onChange?.();
  }

  public getPendingIds(): readonly string[] {
    return [
      ...(this.inFlight ? [this.inFlight.commandId] : []),
      ...this.pending.map((item) => item.commandId),
    ];
  }

  public getState(): {
    readonly pendingIds: readonly string[];
    readonly frozen: boolean;
    readonly revision: number;
  } {
    return {
      pendingIds: this.getPendingIds(),
      frozen: this.frozen,
      revision: this.revision,
    };
  }

  private pump(): void {
    if (this.inFlight || !this.context || this.frozen) return;
    const queued = this.pending.shift();
    if (!queued) return;
    const current: InFlightCommand = {
      ...queued,
      sentAtMs: this.options.nowMs(),
      retried: false,
      request: {
        commandId: queued.commandId,
        command: queued.command,
        expectedRevision: this.revision,
        effectiveAtServerMs: Math.max(
          0,
          Math.round((this.options.serverNowMs ?? this.options.nowMs)() + 750),
        ),
      },
    };
    this.inFlight = current;
    try {
      if (this.options.send(current.request, current.context) === false) {
        this.fail(current, "rejected", "connection-unavailable");
      }
    } catch {
      // A throwing transport may already have sent bytes. Preserve idempotency.
      this.fail(current, "unknown", "transport-error");
    }
  }

  private fail(
    current: InFlightCommand,
    outcome: "unknown" | "rejected",
    reason: string,
  ): void {
    this.inFlight = null;
    this.frozen = true;
    if (outcome === "unknown") {
      this.uncertain.set(current.commandId, current);
      if (this.uncertain.size > 8)
        this.uncertain.delete(this.uncertain.keys().next().value!);
    }
    const discarded = this.pending;
    this.pending = [];
    this.result(current, outcome, reason);
    for (const command of discarded)
      this.result(command, "cancelled", "authority-refresh-required");
    this.options.onChange?.();
    this.options.onRefresh();
  }

  private result(
    command: QueuedCommand,
    outcome: RoomCommandResult["outcome"],
    reason?: string,
    executionRevision?: number,
    currentRevision?: number,
  ): void {
    this.options.onResult?.({
      commandId: command.commandId,
      context: command.context,
      outcome,
      ...(reason ? { reason } : {}),
      ...(executionRevision === undefined ? {} : { executionRevision }),
      ...(currentRevision === undefined ? {} : { currentRevision }),
    });
  }
}

function sameContext(
  left: RoomCommandContext,
  right: RoomCommandContext,
): boolean {
  return (
    left.roomId === right.roomId &&
    left.mediaId === right.mediaId &&
    left.generation === right.generation
  );
}
