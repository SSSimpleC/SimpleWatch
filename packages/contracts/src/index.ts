import { z } from "zod";

export const roomModeSchema = z.enum(["idle", "vod", "live"]);
export type RoomMode = z.infer<typeof roomModeSchema>;

export const participantRoleSchema = z.enum(["admin", "host", "member"]);
export type ParticipantRole = z.infer<typeof participantRoleSchema>;

export const roomIdSchema = z.string().uuid();
export const participantIdSchema = z.string().uuid();

export const playbackRateSchema = z.number().min(0.5).max(2);

export const playbackAnchorSchema = z.object({
  mediaId: z.string().uuid().nullable(),
  paused: z.boolean(),
  positionSeconds: z.number().nonnegative(),
  rate: playbackRateSchema,
  effectiveAtMs: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
});
export type PlaybackAnchor = z.infer<typeof playbackAnchorSchema>;

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    requestId: z.string().min(1),
    details: z.unknown().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const adminLoginRequestSchema = z.object({
  code: z.string().regex(/^\d{6}$/, "放映口令必须为 6 位数字"),
});

export const createRoomRequestSchema = z.object({
  hostNickname: z.string().trim().min(1).max(24),
});
export type CreateRoomRequest = z.infer<typeof createRoomRequestSchema>;

export const joinActiveRoomRequestSchema = z.object({
  nickname: z.string().trim().min(1).max(24),
  inviteToken: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
});
export type JoinActiveRoomRequest = z.infer<typeof joinActiveRoomRequestSchema>;

export const updateRoomRequestSchema = z
  .object({
    close: z.boolean().optional(),
  })
  .refine((value) => value.close === true, {
    message: "必须指定 close",
  });
export type UpdateRoomRequest = z.infer<typeof updateRoomRequestSchema>;

export const kickMemberRequestSchema = z.object({
  reason: z.string().trim().max(200).optional(),
});

export const uploadAuthorizeRequestSchema = z.object({
  filename: z.string().min(1).max(255),
  bytes: z
    .number()
    .int()
    .positive()
    .max(50 * 1024 * 1024 * 1024),
  // 浏览器并不总会为 MKV、M2TS 等文件提供准确 MIME；真实格式由
  // Worker 中的 ffprobe 判断，不能在 HTTP 层把它误杀。
  mime: z.string().trim().min(1).max(255),
});
export type UploadAuthorizeRequest = z.infer<
  typeof uploadAuthorizeRequestSchema
>;

export const mediaStateSchema = z.enum([
  "scanning",
  "compatible",
  "incompatible",
  "failed",
  "published",
]);

export const mediaSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  state: mediaStateSchema,
  bytes: z.number().int().nonnegative(),
  mime: z.string().nullable(),
  compatibilityReasons: z.array(z.string()),
  durationMs: z.number().int().nonnegative().nullable(),
  video: z.object({
    codec: z.enum(["h264", "hevc"]).nullable(),
    playbackSupport: z.enum(["broad", "device-dependent", "unsupported"]),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    fps: z.number().nonnegative().nullable(),
    pixelFormat: z.string().nullable(),
  }),
  audio: z.object({
    codec: z.string().nullable(),
    channels: z.number().int().positive().nullable(),
    sampleRate: z.number().int().positive().nullable(),
  }),
  createdAt: z.iso.datetime(),
  subtitles: z.array(
    z.object({
      id: z.string().uuid(),
      language: z.string(),
      label: z.string(),
      format: z.literal("webvtt"),
    }),
  ),
});

export const subtitleUploadRequestSchema = z.object({
  language: z.string().trim().min(2).max(35),
  label: z.string().trim().min(1).max(80),
  content: z
    .string()
    .min(1)
    .max(2 * 1024 * 1024),
});

export const uploadStateSchema = z.enum([
  "authorized",
  "uploading",
  "received",
  "scanning",
  "compatible",
  "incompatible",
  "failed",
  "published",
  "cancelled",
]);

export const workerResultSchema = z.object({
  compatible: z.boolean(),
  probe: z.record(z.string(), z.unknown()),
  reasons: z.array(z.string()),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative().nullable(),
  finalPath: z.string().min(1),
});

export const transportAnchorSchema = z.object({
  state: z.enum(["playing", "paused"]),
  positionSec: z.number().nonnegative(),
  rate: playbackRateSchema,
  anchoredAtServerMs: z.number().int().nonnegative(),
});
export type TransportAnchor = z.infer<typeof transportAnchorSchema>;

export const roomMemberSchema = z.object({
  id: participantIdSchema,
  nickname: z.string().min(1).max(24),
  role: z.enum(["host", "member"]),
  online: z.boolean(),
});

export const liveStatusSchema = z.object({
  state: z.enum(["offline", "online", "unknown"]),
  hasVideo: z.boolean(),
  hasAudio: z.boolean(),
  videoTrackCount: z.number().int().nonnegative(),
  audioTrackCount: z.number().int().nonnegative(),
  sourceBitrateMbps: z.number().nonnegative().nullable(),
  sourcePacketLossPercent: z.number().min(0).max(100).nullable(),
  sourceHealth: z.enum(["good", "degraded", "poor", "unknown"]),
  checkedAt: z.iso.datetime(),
});

export const activeRoomSummarySchema = z
  .object({
    id: roomIdSchema,
    createdAt: z.iso.datetime(),
    inviteUrl: z.url(),
    memberCount: z.number().int().min(1).max(5),
    onlineCount: z.number().int().min(0).max(5),
    maxMembers: z.literal(5),
    host: z
      .object({
        id: participantIdSchema,
        nickname: z.string().min(1).max(24),
        online: z.boolean(),
      })
      .nullable(),
    mode: roomModeSchema,
    content: z
      .object({
        kind: z.enum(["vod", "live"]),
        id: z.string().uuid().optional(),
        title: z.string(),
      })
      .nullable(),
    live: liveStatusSchema,
  })
  .nullable();

export const roomSnapshotSchema = z.object({
  roomId: roomIdSchema,
  revision: z.number().int().nonnegative(),
  status: z.enum(["active", "closed"]),
  mode: roomModeSchema,
  media: z
    .object({
      id: z.string().uuid(),
      title: z.string(),
      durationSec: z.number().nonnegative(),
    })
    .nullable(),
  live: z
    .object({ state: z.enum(["offline", "connecting", "online"]) })
    .nullable(),
  transport: transportAnchorSchema.nullable(),
  hostMemberId: participantIdSchema,
  members: z.array(roomMemberSchema),
  serverNowMs: z.number().int().nonnegative(),
});
export type RoomSnapshot = z.infer<typeof roomSnapshotSchema>;

export const roomCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("select-vod"), mediaId: z.string().uuid() }),
  z.object({ kind: z.literal("select-live") }),
  z.object({ kind: z.literal("restore-vod") }),
  z.object({ kind: z.literal("play") }),
  z.object({ kind: z.literal("pause") }),
  z.object({ kind: z.literal("seek"), positionSec: z.number().nonnegative() }),
  z.object({ kind: z.literal("set-rate"), rate: playbackRateSchema }),
]);

export const roomCommandRequestSchema = z.object({
  commandId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  effectiveAtServerMs: z.number().int().nonnegative(),
  command: roomCommandSchema,
});
export type RoomCommandRequest = z.infer<typeof roomCommandRequestSchema>;

export const envelopeSchema = <T extends z.ZodType>(payload: T) =>
  z.object({
    v: z.literal(1),
    type: z.string().min(1),
    id: z.string().uuid(),
    roomId: roomIdSchema,
    sentAtMs: z.number().int().nonnegative(),
    payload,
  });
