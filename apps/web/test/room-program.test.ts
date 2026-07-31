import type {
  EdgeTransfer,
  ProgramQueue,
  ProgramQueueItem,
} from "@simplewatch/contracts";
import { describe, expect, it } from "vitest";

import type { RoomSnapshot } from "../src/api.js";
import {
  buildPlaybackProgress,
  buildProgramActivationCommand,
  departureCoverageRatio,
  nextPlaybackSequence,
  PendingProgramCommands,
  programRelayStatus,
  shouldLoadHostProgram,
} from "../src/room-program.js";

const ids = {
  queue: "019f6555-77a3-753c-bbfd-7c27c1d70f50",
  item: "019f6555-77a3-753c-bbfd-7c27c1d70f51",
  version: "019f6555-77a3-753c-bbfd-7c27c1d70f52",
  media: "019f6555-77a3-753c-bbfd-7c27c1d70f53",
  room: "019f6555-77a3-753c-bbfd-7c27c1d70f54",
  host: "019f6555-77a3-753c-bbfd-7c27c1d70f55",
  transfer: "019f6555-77a3-753c-bbfd-7c27c1d70f56",
};

describe("Host room program isolation", () => {
  it("never enables private program requests for a Viewer or a Host without CSRF", () => {
    expect(shouldLoadHostProgram(true, "csrf-token")).toBe(true);
    expect(shouldLoadHostProgram(false, "csrf-token")).toBe(false);
    expect(shouldLoadHostProgram(true, null)).toBe(false);
  });

  it("builds only the queue activation command, including an explicit departure decision", () => {
    expect(
      buildProgramActivationCommand(
        { id: ids.queue },
        { id: ids.item },
        "continue-incomplete",
      ),
    ).toEqual({
      kind: "activate-queue-item",
      programQueueId: ids.queue,
      programItemId: ids.item,
      departureDecision: "continue-incomplete",
    });
  });
});

describe("Host room relay status", () => {
  it("joins an Edge transfer ETA to its program item without exposing paths", () => {
    const item = programItem({ preparationState: "uploading" });
    const transfer: EdgeTransfer = {
      id: ids.transfer,
      catalogVersionId: ids.version,
      displayName: "第二集",
      state: "uploading",
      priority: 10,
      declaredBytes: 4_000,
      transferredBytes: 2_000,
      attempts: 1,
      maxAttempts: 5,
      speedBytesPerSecond: 100,
      etaSeconds: 20,
      errorCode: null,
      errorMessage: null,
      updatedAt: "2026-07-31T12:00:00.000Z",
    };

    expect(programRelayStatus(item, [transfer])).toEqual({
      label: "正在传往云端",
      eta: "约 20 秒后可用",
      tone: "working",
    });
    expect(
      programRelayStatus(programItem({ preparationState: "ready" }), []),
    ).toMatchObject({ eta: "可立即切换", tone: "ready" });
  });
});

describe("room program command correlation", () => {
  it("takes only the rejection matching its commandId and resolves an accepted snapshot", () => {
    const tracker = new PendingProgramCommands();
    const activation = {
      programQueueId: ids.queue,
      programItemId: ids.item,
      mediaId: ids.media,
      displayName: "第二集",
      expectedRoomRevision: 4,
    };
    tracker.track("command-one", activation);
    expect(tracker.take("another-command")).toBeNull();
    expect(tracker.take("command-one")).toEqual(activation);

    tracker.track("command-two", activation);
    expect(
      tracker.resolveSnapshot({ revision: 5, media: { id: ids.media } }),
    ).toBe(true);
    expect(tracker.take("command-two")).toBeNull();
  });

  it("extracts and clamps the structured departure coverage", () => {
    expect(departureCoverageRatio({ coveredRatio: 0.42 })).toBe(0.42);
    expect(departureCoverageRatio({ coveredRatio: 3 })).toBe(1);
    expect(departureCoverageRatio({ coveredRatio: "42%" })).toBeNull();
  });
});

describe("Host playback progress", () => {
  it("keeps sequence monotonic across a simulated page reload", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const first = nextPlaybackSequence(ids.room, 0, storage, 1000);
    const resumed = nextPlaybackSequence(ids.room, 0, storage, 900);

    expect(first).toBe(1000);
    expect(resumed).toBe(1001);
  });

  it("creates progress only for the Host and the active queue media", () => {
    const queue = programQueue();
    const snapshot = roomSnapshot();
    const input = {
      queue,
      snapshot,
      sequence: 17,
      positionSec: 42.5,
      sampledAtClientMs: 1_750_000_000_000,
    };
    expect(buildPlaybackProgress({ ...input, isHost: false })).toBeNull();
    expect(
      buildPlaybackProgress({
        ...input,
        isHost: true,
        snapshot: {
          ...snapshot,
          media: { ...snapshot.media!, id: ids.transfer },
        },
      }),
    ).toBeNull();
    expect(
      buildPlaybackProgress({
        ...input,
        isHost: true,
        playingOverride: false,
      }),
    ).toEqual({
      programQueueId: ids.queue,
      programItemId: ids.item,
      mediaId: ids.media,
      roomRevision: 7,
      sequence: 17,
      positionSec: 42.5,
      playing: false,
      rate: 1,
      sampledAtClientMs: 1_750_000_000_000,
    });
  });
});

function programItem(
  overrides: Partial<ProgramQueueItem> = {},
): ProgramQueueItem {
  return {
    id: ids.item,
    queueId: ids.queue,
    catalogVersionId: ids.version,
    transferId: ids.transfer,
    mediaId: ids.media,
    displayName: "第二集",
    position: 1,
    preparationState: "ready",
    playbackState: "current",
    pinned: false,
    watchCoverage: null,
    ...overrides,
  };
}

function programQueue(): ProgramQueue {
  return {
    id: ids.queue,
    displayName: "今晚",
    state: "active",
    revision: 3,
    currentItemId: ids.item,
    items: [programItem()],
    createdAt: "2026-07-31T12:00:00.000Z",
    updatedAt: "2026-07-31T12:00:00.000Z",
  };
}

function roomSnapshot(): RoomSnapshot {
  return {
    roomId: ids.room,
    revision: 7,
    status: "active",
    mode: "vod",
    media: { id: ids.media, title: "第二集", durationSec: 3000 },
    live: null,
    transport: {
      state: "playing",
      positionSec: 42.5,
      rate: 1,
      anchoredAtServerMs: 1_750_000_000_000,
    },
    hostMemberId: ids.host,
    members: [{ id: ids.host, nickname: "Host", role: "host", online: true }],
    serverNowMs: 1_750_000_000_000,
  };
}
