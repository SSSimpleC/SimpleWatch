import { z } from "zod";

export const edgeSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const edgeIdSchema = z.string().uuid();

export const edgeRelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value
        .split("/")
        .every(
          (segment) => segment !== "" && segment !== "." && segment !== "..",
        ),
    "必须是 Library 根目录内的规范相对路径",
  );

export const edgeAgentStateSchema = z.enum([
  "online",
  "offline",
  "stale",
  "revoked",
]);

export const edgeAgentSummarySchema = z.object({
  id: edgeIdSchema,
  displayName: z.string().trim().min(1).max(120),
  state: edgeAgentStateSchema,
  protocolVersion: z.number().int().positive(),
  softwareVersion: z.string().trim().min(1).max(120),
  lastSeenAt: z.iso.datetime().nullable(),
  lastCompleteScanAt: z.iso.datetime().nullable(),
  catalogItemCount: z.number().int().nonnegative(),
  credentialExpiresAt: z.iso.datetime().nullable(),
  credentialExpiringSoon: z.boolean(),
});
export type EdgeAgentSummary = z.infer<typeof edgeAgentSummarySchema>;

export const edgeCatalogRefreshRequestSchema = z.object({}).strict();
export const edgeCatalogRefreshTaskStateSchema = z.enum(["queued", "leased"]);
export const edgeCatalogRefreshResponseSchema = z.object({
  agent: edgeAgentSummarySchema,
  task: z.object({
    id: edgeIdSchema,
    state: edgeCatalogRefreshTaskStateSchema,
    deduplicated: z.boolean(),
  }),
});
export type EdgeCatalogRefreshResponse = z.infer<
  typeof edgeCatalogRefreshResponseSchema
>;

export const edgeCatalogEntrySchema = z.object({
  localId: z.string().min(1).max(512),
  relativePath: edgeRelativePathSchema,
  displayName: z.string().trim().min(1).max(255),
  bytes: z.number().int().nonnegative().safe(),
  mtimeMs: z.number().int().nonnegative().safe(),
});
export type EdgeCatalogEntry = z.infer<typeof edgeCatalogEntrySchema>;

export const edgeCatalogScanCreateRequestSchema = z.object({
  generation: z.number().int().positive(),
});
export const edgeCatalogScanCreatedSchema = z.object({
  scanId: edgeIdSchema,
  generation: z.number().int().positive(),
});

export const edgeCatalogScanPageRequestSchema = z
  .object({
    generation: z.number().int().positive(),
    pageIndex: z.number().int().nonnegative(),
    entries: z.array(edgeCatalogEntrySchema).max(2000),
  })
  .superRefine((value, context) => {
    const ids = new Set<string>();
    for (const entry of value.entries) {
      if (ids.has(entry.localId)) {
        context.addIssue({
          code: "custom",
          path: ["entries"],
          message: "同一分页中 localId 不得重复",
        });
        return;
      }
      ids.add(entry.localId);
    }
  });
export type EdgeCatalogScanPageRequest = z.infer<
  typeof edgeCatalogScanPageRequestSchema
>;

export const edgeCatalogScanCommitRequestSchema = z.object({
  generation: z.number().int().positive(),
  pageCount: z.number().int().nonnegative(),
});

export const edgeCatalogSourceStateSchema = z.enum([
  "present",
  "missing",
  "changed",
]);

export const edgeCatalogCloudStateSchema = z.enum([
  "not-requested",
  "queued",
  "validating",
  "uploading",
  "processing",
  "ready",
  "blocked",
  "failed",
  "evicted",
]);

export const edgeCatalogItemSchema = z.object({
  id: edgeIdSchema,
  versionId: edgeIdSchema,
  relativePath: edgeRelativePathSchema,
  displayName: z.string().min(1).max(255),
  bytes: z.number().int().nonnegative().safe(),
  mtimeMs: z.number().int().nonnegative().safe(),
  sourceState: edgeCatalogSourceStateSchema,
  cloudState: edgeCatalogCloudStateSchema,
  sha256: edgeSha256Schema.nullable(),
});
export type EdgeCatalogItem = z.infer<typeof edgeCatalogItemSchema>;

export const edgeCatalogPageSchema = z.object({
  items: z.array(edgeCatalogItemSchema),
  nextCursor: z.string().min(1).nullable(),
});
export type EdgeCatalogPage = z.infer<typeof edgeCatalogPageSchema>;

export const edgeAgentTaskKindSchema = z.enum([
  "catalog_scan",
  "upload",
  "verify_source",
  "cancel_transfer",
]);

const edgeSourceIdentitySchema = z.object({
  catalogItemId: edgeIdSchema,
  catalogVersionId: edgeIdSchema,
  localId: z.string().min(1).max(512),
  expectedBytes: z.number().int().nonnegative().safe(),
  expectedMtimeMs: z.number().int().nonnegative().safe(),
  expectedSha256: edgeSha256Schema.nullable(),
});

export const edgeAgentTaskPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("catalog_scan"),
    generation: z.number().int().positive(),
  }),
  edgeSourceIdentitySchema.extend({
    kind: z.literal("upload"),
    edgeTransferId: edgeIdSchema,
  }),
  edgeSourceIdentitySchema.extend({
    kind: z.literal("verify_source"),
    edgeTransferId: edgeIdSchema.nullable(),
    cacheReplicaId: edgeIdSchema,
  }),
  z.object({
    kind: z.literal("cancel_transfer"),
    edgeTransferId: edgeIdSchema,
  }),
]);
export type EdgeAgentTaskPayload = z.infer<typeof edgeAgentTaskPayloadSchema>;

export const edgeClaimedJobSchema = z.object({
  id: edgeIdSchema,
  leaseToken: z.string().min(32).max(512),
  leaseExpiresAt: z.iso.datetime(),
  attempts: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  payload: edgeAgentTaskPayloadSchema,
});
export type EdgeClaimedJob = z.infer<typeof edgeClaimedJobSchema>;

export const edgeJobHeartbeatRequestSchema = z.object({
  leaseToken: z.string().min(32).max(512),
  bytesTransferred: z.number().int().nonnegative().safe().optional(),
});

export const edgeJobHeartbeatResponseSchema = z.object({
  leaseExpiresAt: z.iso.datetime(),
  cancelRequested: z.boolean(),
});
export type EdgeJobHeartbeatResponse = z.infer<
  typeof edgeJobHeartbeatResponseSchema
>;

export const edgeSourceProofSchema = z.object({
  bytes: z.number().int().nonnegative().safe(),
  mtimeMs: z.number().int().nonnegative().safe(),
  sha256: edgeSha256Schema,
});
export type EdgeSourceProof = z.infer<typeof edgeSourceProofSchema>;

export const edgeJobCompleteRequestSchema = z.object({
  leaseToken: z.string().min(32).max(512),
  source: edgeSourceProofSchema.optional(),
});

export const edgeJobFailureCodeSchema = z.enum([
  "SOURCE_MISSING",
  "SOURCE_CHANGED",
  "PERMISSION_DENIED",
  "INSUFFICIENT_STORAGE",
  "TRANSFER_STALLED",
  "NETWORK_ERROR",
  "INTERNAL_ERROR",
]);
export type EdgeJobFailureCode = z.infer<typeof edgeJobFailureCodeSchema>;

export const edgeJobFailRequestSchema = z.object({
  leaseToken: z.string().min(32).max(512),
  code: edgeJobFailureCodeSchema,
  message: z.string().trim().min(1).max(1000),
  retryable: z.boolean(),
});

export const edgeTusCredentialSchema = z.object({
  edgeTransferId: edgeIdSchema,
  uploadId: edgeIdSchema,
  tusUrl: z.string().min(1).max(4096),
  token: z.string().min(32).max(4096),
  expiresAt: z.iso.datetime(),
  refreshAfter: z.iso.datetime(),
  chunkBytes: z.number().int().positive(),
});
export type EdgeTusCredential = z.infer<typeof edgeTusCredentialSchema>;

export const edgeTransferStateSchema = z.enum([
  "queued",
  "leased",
  "validating",
  "uploading",
  "received",
  "processing",
  "ready",
  "blocked_storage",
  "source_missing",
  "source_changed",
  "permission_denied",
  "cancel_requested",
  "cancelled",
  "incompatible",
  "failed",
  "evicted",
]);

export const edgeTransferSchema = z.object({
  id: edgeIdSchema,
  catalogVersionId: edgeIdSchema.nullable(),
  displayName: z.string().min(1).max(255),
  state: edgeTransferStateSchema,
  priority: z.number().int(),
  declaredBytes: z.number().int().nonnegative().safe(),
  transferredBytes: z.number().int().nonnegative().safe(),
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  speedBytesPerSecond: z.number().nonnegative().nullable(),
  etaSeconds: z.number().int().nonnegative().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});
export type EdgeTransfer = z.infer<typeof edgeTransferSchema>;

export const edgeCacheReplicaStateSchema = z.enum([
  "ready",
  "protected",
  "eligible",
  "verifying_source",
  "evicting",
  "evicted",
  "recovery_blocked",
]);

export const edgeCacheReplicaSchema = z.object({
  id: edgeIdSchema,
  mediaId: edgeIdSchema.nullable(),
  catalogVersionId: edgeIdSchema.nullable(),
  displayName: z.string().min(1).max(255),
  bytes: z.number().int().nonnegative().safe(),
  state: edgeCacheReplicaStateSchema,
  pinned: z.boolean(),
  generation: z.number().int().positive(),
  rowVersion: z.number().int().nonnegative(),
  sourceVerifiedAt: z.iso.datetime().nullable(),
  protectedReason: z.string().nullable(),
});
export type EdgeCacheReplica = z.infer<typeof edgeCacheReplicaSchema>;

export const edgeCacheMutationRequestSchema = z.object({
  expectedGeneration: z.number().int().positive(),
  expectedRowVersion: z.number().int().nonnegative(),
});

export const edgeCachePinRequestSchema = edgeCacheMutationRequestSchema.extend({
  pinned: z.boolean(),
});

export const cloudStorageSummarySchema = z.object({
  capacityBytes: z.number().int().nonnegative().safe(),
  freeBytes: z.number().int().nonnegative().safe(),
  reservedBytes: z.number().int().nonnegative().safe(),
  safetyFloorBytes: z.number().int().nonnegative().safe(),
  permanentMediaBytes: z.number().int().nonnegative().safe(),
  edgeCacheBytes: z.number().int().nonnegative().safe(),
  inFlightBytes: z.number().int().nonnegative().safe(),
});
export type CloudStorageSummary = z.infer<typeof cloudStorageSummarySchema>;

export const edgeAdminEventSchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    "edge.agent.changed",
    "edge.catalog.changed",
    "edge.transfer.changed",
    "edge.cache.changed",
    "program.queue.changed",
    "storage.changed",
  ]),
  entityId: z.string().min(1).nullable(),
  revision: z.number().int().nonnegative(),
  occurredAt: z.iso.datetime(),
});
export type EdgeAdminEvent = z.infer<typeof edgeAdminEventSchema>;
