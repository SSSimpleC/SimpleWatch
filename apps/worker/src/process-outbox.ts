import { z } from "zod";

export interface LiveKitRoomAdmin {
  removeParticipant(
    room: string,
    identity: string,
    options?: { revokeTokenTs?: bigint },
  ): Promise<void>;
  listParticipants?(room: string): Promise<Array<{ identity: string }>>;
}

export interface OutboxItem {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly leaseToken: string;
}

interface OutboxDependencies {
  readonly livekit: LiveKitRoomAdmin;
  readonly mediamtxControlUrl: string;
  readonly fetchImpl?: typeof fetch;
}

const rtcPayloadSchema = z.object({
  roomId: z.string().uuid(),
  memberId: z.string().uuid(),
});

const mediaPayloadSchema = z.object({
  roomId: z.string().min(1),
  memberId: z.string().min(1),
  sessionIds: z.array(z.string().min(1)).max(512),
});

const MEDIA_SESSION_KICK_BATCH_SIZE = 32;

export async function processOutboxItem(
  item: OutboxItem,
  dependencies: OutboxDependencies,
): Promise<void> {
  if (item.kind === "rtc.remove-participant") {
    const payload = rtcPayloadSchema.parse(item.payload);
    try {
      await dependencies.livekit.removeParticipant(
        `voice:${payload.roomId}`,
        payload.memberId,
      );
    } catch (error) {
      // LiveKit 对已经离开的成员返回 not found；撤销操作应当幂等，
      // 否则 outbox 会无意义地持续重试。
      const message = error instanceof Error ? error.message : String(error);
      if (
        !/participant.+(?:does not exist|not found)|not found/i.test(message)
      ) {
        throw error;
      }
    }
    return;
  }

  if (item.kind === "mediamtx.kick-sessions") {
    const payload = mediaPayloadSchema.parse(item.payload);
    const fetchImpl = dependencies.fetchImpl ?? fetch;
    const sessionIds = [...new Set(payload.sessionIds)];
    for (
      let index = 0;
      index < sessionIds.length;
      index += MEDIA_SESSION_KICK_BATCH_SIZE
    ) {
      const chunk = sessionIds.slice(
        index,
        index + MEDIA_SESSION_KICK_BATCH_SIZE,
      );
      await Promise.all(
        chunk.map(async (sessionId) => {
          const response = await fetchImpl(
            new URL(
              `/v3/webrtcsessions/kick/${encodeURIComponent(sessionId)}`,
              dependencies.mediamtxControlUrl,
            ),
            { method: "POST" },
          );
          if (!response.ok && response.status !== 404) {
            throw new Error(
              `MediaMTX 会话 ${sessionId} 踢出失败：HTTP ${response.status}`,
            );
          }
        }),
      );
    }
    return;
  }

  throw new Error(`不支持的 outbox 类型：${item.kind}`);
}

export async function reconcileRtcParticipants(
  rooms: Array<{ roomId: string; activeMemberIds: string[] }>,
  livekit: Required<Pick<LiveKitRoomAdmin, "listParticipants">> &
    Pick<LiveKitRoomAdmin, "removeParticipant">,
): Promise<number> {
  let removed = 0;
  for (const room of rooms) {
    const active = new Set(room.activeMemberIds);
    const roomName = `voice:${room.roomId}`;
    const participants = await livekit.listParticipants(roomName);
    for (const participant of participants) {
      if (!active.has(participant.identity)) {
        await livekit.removeParticipant(roomName, participant.identity);
        removed += 1;
      }
    }
  }
  return removed;
}
