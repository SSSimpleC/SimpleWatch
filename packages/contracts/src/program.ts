import { z } from "zod";

const idSchema = z.string().uuid();

export const programQueueStateSchema = z.enum([
  "active",
  "completed",
  "cleared",
]);

export const programItemPreparationStateSchema = z.enum([
  "pending",
  "queued",
  "validating",
  "uploading",
  "processing",
  "ready",
  "blocked",
  "failed",
  "evicted",
]);

export const programItemPlaybackStateSchema = z.enum([
  "upcoming",
  "current",
  "completed",
  "incomplete",
  "removed",
]);

export const watchCompletionKindSchema = z.enum([
  "automatic",
  "manual",
  "incomplete",
]);

export const watchRangeSchema = z
  .object({
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
  })
  .refine((value) => value.endMs > value.startMs, {
    message: "观看区间终点必须晚于起点",
  });

export const watchCoverageSchema = z.object({
  historyId: idSchema,
  durationMs: z.number().int().nonnegative().nullable(),
  coveredMs: z.number().int().nonnegative(),
  coveredRatio: z.number().min(0).max(1),
  completed: z.boolean(),
  completionKind: watchCompletionKindSchema.nullable(),
  ranges: z.array(watchRangeSchema),
});
export type WatchCoverage = z.infer<typeof watchCoverageSchema>;

export const programQueueItemSchema = z.object({
  id: idSchema,
  queueId: idSchema,
  catalogVersionId: idSchema.nullable(),
  transferId: idSchema.nullable(),
  mediaId: idSchema.nullable(),
  displayName: z.string().min(1).max(255),
  position: z.number().int().nonnegative(),
  preparationState: programItemPreparationStateSchema,
  playbackState: programItemPlaybackStateSchema,
  pinned: z.boolean(),
  watchCoverage: watchCoverageSchema.nullable(),
});
export type ProgramQueueItem = z.infer<typeof programQueueItemSchema>;

export const programQueueSchema = z.object({
  id: idSchema,
  displayName: z.string().min(1).max(120),
  state: programQueueStateSchema,
  revision: z.number().int().nonnegative(),
  currentItemId: idSchema.nullable(),
  items: z.array(programQueueItemSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ProgramQueue = z.infer<typeof programQueueSchema>;

export const programQueueAddItemsRequestSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  catalogVersionIds: z.array(idSchema).min(1).max(500),
});

export const programQueueReorderRequestSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  itemIds: z.array(idSchema).min(1).max(500),
});

export const programQueueItemMutationRequestSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
});

export const programQueueItemPinRequestSchema =
  programQueueItemMutationRequestSchema.extend({ pinned: z.boolean() });

export const departureDecisionSchema = z.enum([
  "confirm-complete",
  "continue-incomplete",
]);

export const activateProgramQueueItemCommandSchema = z.object({
  kind: z.literal("activate-queue-item"),
  programQueueId: idSchema,
  programItemId: idSchema,
  departureDecision: departureDecisionSchema.optional(),
});
export type ActivateProgramQueueItemCommand = z.infer<
  typeof activateProgramQueueItemCommandSchema
>;

export const playbackProgressSchema = z.object({
  programQueueId: idSchema,
  programItemId: idSchema,
  mediaId: idSchema,
  roomRevision: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
  positionSec: z.number().nonnegative(),
  playing: z.boolean(),
  rate: z.number().min(0.5).max(2),
  sampledAtClientMs: z.number().int().nonnegative(),
});
export type PlaybackProgress = z.infer<typeof playbackProgressSchema>;
