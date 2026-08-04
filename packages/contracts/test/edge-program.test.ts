import { describe, expect, it } from "vitest";

import {
  edgeAgentSummarySchema,
  edgeCatalogRefreshResponseSchema,
  edgeCatalogScanPageRequestSchema,
  edgeClaimedJobSchema,
  edgeRelativePathSchema,
  playbackProgressSchema,
  roomCommandSchema,
  roomSnapshotSchema,
  workerResultSchema,
} from "../src/index.js";

const ids = {
  task: "0198c33d-b63a-73f4-bc1d-357179381138",
  transfer: "0198c33d-b63a-73f4-bc1d-357179381139",
  item: "0198c33d-b63a-73f4-bc1d-357179381140",
  version: "0198c33d-b63a-73f4-bc1d-357179381141",
  queue: "0198c33d-b63a-73f4-bc1d-357179381142",
  programItem: "0198c33d-b63a-73f4-bc1d-357179381143",
  media: "0198c33d-b63a-73f4-bc1d-357179381144",
};

describe("Edge contracts", () => {
  it("exposes credential expiry metadata without exposing a token", () => {
    const expiring = edgeAgentSummarySchema.parse({
      id: ids.task,
      displayName: "SimpleServer",
      state: "online",
      protocolVersion: 1,
      softwareVersion: "0.1.0",
      lastSeenAt: "2026-07-31T15:00:00.000Z",
      lastCompleteScanAt: null,
      catalogItemCount: 12,
      credentialExpiresAt: "2026-08-10T15:00:00.000Z",
      credentialExpiringSoon: true,
    });
    expect(expiring.credentialExpiringSoon).toBe(true);
    expect(expiring).not.toHaveProperty("token");

    expect(
      edgeAgentSummarySchema.parse({
        ...expiring,
        credentialExpiresAt: null,
        credentialExpiringSoon: false,
      }),
    ).toMatchObject({
      credentialExpiresAt: null,
      credentialExpiringSoon: false,
    });
  });

  it("describes an idempotent Host catalog refresh result", () => {
    expect(
      edgeCatalogRefreshResponseSchema.parse({
        agent: {
          id: ids.task,
          displayName: "SimpleServer",
          state: "offline",
          protocolVersion: 1,
          softwareVersion: "0.1.0",
          lastSeenAt: null,
          lastCompleteScanAt: null,
          catalogItemCount: 0,
          credentialExpiresAt: null,
          credentialExpiringSoon: false,
        },
        task: { id: ids.transfer, state: "queued", deduplicated: true },
      }),
    ).toMatchObject({
      agent: { state: "offline" },
      task: { state: "queued", deduplicated: true },
    });
  });

  it("accepts a Library-relative catalog page and rejects traversal", () => {
    expect(edgeRelativePathSchema.parse("Series/01 第一集.mkv")).toBe(
      "Series/01 第一集.mkv",
    );
    expect(() => edgeRelativePathSchema.parse("../secret.mkv")).toThrow();
    expect(() => edgeRelativePathSchema.parse("/absolute/video.mkv")).toThrow();

    const duplicateEntry = {
      localId: "stable-file-id",
      relativePath: "Series/01.mkv",
      displayName: "01.mkv",
      bytes: 900_000_000,
      mtimeMs: 1_750_000_000_000,
    };
    expect(
      edgeCatalogScanPageRequestSchema.safeParse({
        generation: 1,
        pageIndex: 0,
        entries: [duplicateEntry, duplicateEntry],
      }).success,
    ).toBe(false);
  });

  it("validates a leased upload job without exposing an absolute path", () => {
    const parsed = edgeClaimedJobSchema.parse({
      id: ids.task,
      leaseToken: "l".repeat(43),
      leaseExpiresAt: "2026-07-31T15:00:00.000Z",
      attempts: 1,
      maxAttempts: 5,
      payload: {
        kind: "upload",
        edgeTransferId: ids.transfer,
        catalogItemId: ids.item,
        catalogVersionId: ids.version,
        localId: "stable-file-id",
        expectedBytes: 900_000_000,
        expectedMtimeMs: 1_750_000_000_000,
        expectedSha256: null,
      },
    });

    expect(parsed.payload.kind).toBe("upload");
    expect(parsed.payload).not.toHaveProperty("relativePath");
    expect(parsed.payload).not.toHaveProperty("absolutePath");
  });

  it("keeps the Edge source digest separate from the published digest", () => {
    const result = workerResultSchema.parse({
      compatible: true,
      probe: {},
      reasons: [],
      sha256: "a".repeat(64),
      sourceSha256: "b".repeat(64),
      bytes: 123,
      durationMs: 456,
      finalPath: "/srv/media/final.mp4",
    });

    expect(result.sha256).toBe("a".repeat(64));
    expect(result.sourceSha256).toBe("b".repeat(64));
  });
});

describe("program queue contracts", () => {
  it("extends Host commands with explicit queue activation decisions", () => {
    expect(
      roomCommandSchema.parse({
        kind: "activate-queue-item",
        programQueueId: ids.queue,
        programItemId: ids.programItem,
        departureDecision: "continue-incomplete",
      }),
    ).toMatchObject({ kind: "activate-queue-item" });

    expect(
      roomCommandSchema.safeParse({
        kind: "activate-queue-item",
        programQueueId: ids.queue,
        programItemId: ids.programItem,
        departureDecision: "silently-complete",
      }).success,
    ).toBe(false);
  });

  it("validates monotonic playback progress samples", () => {
    expect(
      playbackProgressSchema.parse({
        programQueueId: ids.queue,
        programItemId: ids.programItem,
        mediaId: ids.media,
        roomRevision: 7,
        sequence: 42,
        positionSec: 312.5,
        playing: true,
        rate: 1,
        sampledAtClientMs: 1_750_000_000_000,
      }),
    ).toMatchObject({ sequence: 42, positionSec: 312.5 });
  });

  it("does not add Edge or program internals to the Viewer room snapshot", () => {
    expect(Object.keys(roomSnapshotSchema.shape)).not.toContain(
      "programQueueId",
    );
    expect(Object.keys(roomSnapshotSchema.shape)).not.toContain(
      "currentProgramItemId",
    );
    expect(Object.keys(roomSnapshotSchema.shape)).not.toContain("edgeAgentId");
  });
});
