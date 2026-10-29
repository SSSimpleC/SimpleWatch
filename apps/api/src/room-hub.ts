import { v7 as uuidv7 } from "uuid";
import type {
  PlaybackStatus,
  PlaybackStatusSummary,
} from "@simplewatch/contracts";

interface SocketLike {
  readonly readyState: number;
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

interface RoomConnection {
  readonly memberId: string;
  readonly socket: SocketLike;
  readonly access: PlaybackAccess | undefined;
}

interface PlaybackAccess {
  readonly role: "host" | "member";
  readonly nickname: string;
  readonly authorize: () => boolean;
}

interface PlaybackObservation {
  readonly receivedAtMs: number;
  readonly report: PlaybackStatus;
  readonly access: PlaybackAccess;
}

const OPEN_STATE = 1;

export class RoomHub {
  private readonly sockets = new Map<string, Set<RoomConnection>>();
  private readonly observations = new Map<
    string,
    Map<string, PlaybackObservation>
  >();
  private readonly observationSweep: ReturnType<typeof setInterval>;

  public constructor(private readonly now: () => number = Date.now) {
    this.observationSweep = setInterval(() => {
      for (const roomId of this.observations.keys()) {
        if (this.pruneObservations(roomId)) this.publishPlaybackSummary(roomId);
      }
    }, 2000);
    this.observationSweep.unref();
  }

  public dispose(): void {
    clearInterval(this.observationSweep);
    this.observations.clear();
  }

  public add(
    roomId: string,
    memberId: string,
    socket: SocketLike,
    access?: PlaybackAccess,
  ): () => void {
    const roomSockets = this.sockets.get(roomId) ?? new Set<RoomConnection>();
    const connection = { memberId, socket, access };
    roomSockets.add(connection);
    this.sockets.set(roomId, roomSockets);

    return () => {
      roomSockets.delete(connection);
      if (roomSockets.size === 0) this.sockets.delete(roomId);
      // Keep the last observation (and its per-seat rate limit) for the bounded
      // TTL, including brief reconnects. Revoked observations are pruned below.
    };
  }

  public recordPlaybackStatus(
    roomId: string,
    memberId: string,
    report: PlaybackStatus,
    access: PlaybackAccess,
  ): boolean {
    this.pruneObservations(roomId);
    const reports =
      this.observations.get(roomId) ?? new Map<string, PlaybackObservation>();
    const previous = reports.get(memberId);
    if (previous && this.now() - previous.receivedAtMs < 1000) return false;
    reports.set(memberId, { receivedAtMs: this.now(), report, access });
    this.observations.set(roomId, reports);
    this.publishPlaybackSummary(roomId);
    return true;
  }

  public publishPlaybackSummary(roomId: string, onlySocket?: SocketLike): void {
    this.pruneObservations(roomId);
    const payload: PlaybackStatusSummary = {
      reports: [...(this.observations.get(roomId) ?? [])].map(
        ([memberId, observation]) => ({
          memberId,
          nickname: observation.access.nickname,
          receivedAtMs: observation.receivedAtMs,
          report: observation.report,
        }),
      ),
      serverNowMs: this.now(),
    };
    const serialized = JSON.stringify({
      v: 1,
      type: "playback.status.summary",
      id: uuidv7(),
      roomId,
      sentAtMs: this.now(),
      payload,
    });
    for (const connection of this.sockets.get(roomId) ?? []) {
      if (onlySocket && connection.socket !== onlySocket) continue;
      if (
        connection.access?.role === "host" &&
        connection.socket.readyState === OPEN_STATE &&
        connection.access.authorize()
      )
        connection.socket.send(serialized);
    }
  }

  private pruneObservations(roomId: string): boolean {
    const reports = this.observations.get(roomId);
    if (!reports) return false;
    let changed = false;
    for (const [memberId, observation] of reports) {
      if (
        this.now() - observation.receivedAtMs >= 30_000 ||
        !observation.access.authorize()
      ) {
        reports.delete(memberId);
        changed = true;
      }
    }
    if (reports.size === 0) this.observations.delete(roomId);
    return changed;
  }

  public broadcast(roomId: string, payload: unknown): void {
    const serialized = JSON.stringify(payload);
    for (const connection of this.sockets.get(roomId) ?? []) {
      if (connection.socket.readyState !== OPEN_STATE) continue;
      let authorized = false;
      try {
        authorized = connection.access?.authorize() ?? true;
      } catch {
        // A failed revalidation must not leak a snapshot or block other seats.
      }
      if (!authorized) {
        closeSocketSafely(connection.socket, 4001, "session invalid");
        continue;
      }
      try {
        connection.socket.send(serialized);
      } catch {
        // A broken peer must not prevent delivery to the remaining room.
        closeSocketSafely(connection.socket, 1011, "send failed");
      }
    }
  }

  public closeMember(
    roomId: string,
    memberId: string,
    code: number,
    reason: string,
  ): void {
    for (const connection of this.sockets.get(roomId) ?? []) {
      if (connection.memberId === memberId)
        connection.socket.close(code, reason);
    }
  }

  public closeRoom(roomId: string, code: number, reason: string): void {
    for (const connection of this.sockets.get(roomId) ?? []) {
      connection.socket.close(code, reason);
    }
  }
}

function closeSocketSafely(
  socket: SocketLike,
  code: number,
  reason: string,
): void {
  try {
    socket.close(code, reason);
  } catch {
    // A socket already failing to close is still excluded from this send.
  }
}
