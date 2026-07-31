import type {
  ActivateProgramQueueItemCommand,
  EdgeTransfer,
  PlaybackProgress,
  ProgramQueue,
  ProgramQueueItem,
} from "@simplewatch/contracts";

import type { RoomSnapshot } from "./api.js";

export type DepartureDecision = "confirm-complete" | "continue-incomplete";

export interface PendingProgramActivation {
  readonly programQueueId: string;
  readonly programItemId: string;
  readonly mediaId: string;
  readonly displayName: string;
  readonly expectedRoomRevision: number;
}

export interface ProgramRelayStatus {
  readonly label: string;
  readonly eta: string | null;
  readonly tone: "waiting" | "working" | "ready" | "blocked" | "failed";
}

interface SequenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function shouldLoadHostProgram(
  isHost: boolean,
  adminCsrf: string | null,
): boolean {
  return isHost && Boolean(adminCsrf);
}

export function buildProgramActivationCommand(
  queue: Pick<ProgramQueue, "id">,
  item: Pick<ProgramQueueItem, "id">,
  departureDecision?: DepartureDecision,
): ActivateProgramQueueItemCommand {
  return {
    kind: "activate-queue-item",
    programQueueId: queue.id,
    programItemId: item.id,
    ...(departureDecision ? { departureDecision } : {}),
  };
}

export function currentProgramItem(
  queue: ProgramQueue | null | undefined,
  mediaId: string | null | undefined,
): ProgramQueueItem | null {
  if (!queue?.currentItemId || !mediaId) return null;
  return (
    queue.items.find(
      (item) =>
        item.id === queue.currentItemId &&
        item.mediaId === mediaId &&
        item.playbackState === "current",
    ) ?? null
  );
}

export function programRelayStatus(
  item: ProgramQueueItem,
  transfers: readonly EdgeTransfer[],
): ProgramRelayStatus {
  if (item.preparationState === "ready") {
    return { label: "云端已就绪", eta: "可立即切换", tone: "ready" };
  }
  const transfer = transfers.find(
    (candidate) =>
      item.catalogVersionId !== null &&
      candidate.catalogVersionId === item.catalogVersionId,
  );
  const eta =
    transfer?.etaSeconds === null || transfer?.etaSeconds === undefined
      ? null
      : `约 ${formatEta(transfer.etaSeconds)}可用`;
  const states: Record<
    ProgramQueueItem["preparationState"],
    Omit<ProgramRelayStatus, "eta">
  > = {
    pending: { label: "等待进入预取窗口", tone: "waiting" },
    queued: { label: "等待家庭服务器", tone: "waiting" },
    validating: { label: "正在核验家庭原片", tone: "working" },
    uploading: { label: "正在传往云端", tone: "working" },
    processing: { label: "云端正在整理", tone: "working" },
    ready: { label: "云端已就绪", tone: "ready" },
    blocked: { label: "云端空间不足", tone: "blocked" },
    failed: { label: "准备失败", tone: "failed" },
    evicted: { label: "缓存已回收", tone: "waiting" },
  };
  return { ...states[item.preparationState], eta };
}

export function playbackStateLabel(
  state: ProgramQueueItem["playbackState"],
): string {
  return (
    {
      upcoming: "待放映",
      current: "正在放映",
      completed: "已看完",
      incomplete: "保留未完",
      removed: "已移除",
    } as const
  )[state];
}

export function nextPlaybackSequence(
  roomId: string,
  fallback: number,
  storage: SequenceStorage | null,
  now = Date.now(),
): number {
  const key = `simplewatch.playback-progress-sequence:${roomId}`;
  let persisted = 0;
  try {
    persisted = Number(storage?.getItem(key) ?? 0);
  } catch {
    persisted = 0;
  }
  const next = Math.max(
    Number.isSafeInteger(fallback) ? fallback + 1 : 1,
    Number.isSafeInteger(persisted) ? persisted + 1 : 1,
    Math.floor(now),
  );
  try {
    storage?.setItem(key, String(next));
  } catch {
    // Private browsing and exhausted storage must not stop progress reporting.
  }
  return next;
}

export function buildPlaybackProgress(input: {
  readonly isHost: boolean;
  readonly queue: ProgramQueue | null | undefined;
  readonly snapshot: RoomSnapshot | null | undefined;
  readonly sequence: number;
  readonly positionSec: number;
  readonly sampledAtClientMs: number;
  readonly playingOverride?: boolean;
}): PlaybackProgress | null {
  const item = currentProgramItem(input.queue, input.snapshot?.media?.id);
  const transport = input.snapshot?.transport;
  if (
    !input.isHost ||
    !item ||
    !input.queue ||
    !input.snapshot?.media ||
    input.snapshot.mode !== "vod" ||
    !transport
  ) {
    return null;
  }
  return {
    programQueueId: input.queue.id,
    programItemId: item.id,
    mediaId: input.snapshot.media.id,
    roomRevision: input.snapshot.revision,
    sequence: input.sequence,
    positionSec: Math.max(0, input.positionSec),
    playing: input.playingOverride ?? transport.state === "playing",
    rate: transport.rate,
    sampledAtClientMs: input.sampledAtClientMs,
  };
}

export function departureCoverageRatio(details: unknown): number | null {
  if (!details || typeof details !== "object" || !("coveredRatio" in details))
    return null;
  const ratio = (details as { coveredRatio?: unknown }).coveredRatio;
  return typeof ratio === "number" && Number.isFinite(ratio)
    ? Math.min(1, Math.max(0, ratio))
    : null;
}

export class PendingProgramCommands {
  private readonly activations = new Map<string, PendingProgramActivation>();

  public track(commandId: string, activation: PendingProgramActivation): void {
    this.activations.set(commandId, activation);
  }

  public take(
    commandId: string | null | undefined,
  ): PendingProgramActivation | null {
    if (!commandId) return null;
    const activation = this.activations.get(commandId) ?? null;
    if (activation) this.activations.delete(commandId);
    return activation;
  }

  public resolveSnapshot(snapshot: {
    readonly revision: number;
    readonly media: { readonly id: string } | null;
  }): boolean {
    let resolved = false;
    for (const [commandId, activation] of this.activations) {
      if (
        snapshot.revision > activation.expectedRoomRevision &&
        snapshot.media?.id === activation.mediaId
      ) {
        this.activations.delete(commandId);
        resolved = true;
      }
    }
    return resolved;
  }

  public clear(): void {
    this.activations.clear();
  }
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))} 秒后`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分钟后`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.ceil((seconds % 3600) / 60);
  return minutes > 0 ? `${hours} 小时 ${minutes} 分钟后` : `${hours} 小时后`;
}
