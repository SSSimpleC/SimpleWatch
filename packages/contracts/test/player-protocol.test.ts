import { describe, expect, it } from "vitest";
import {
  playbackStatusSchema,
  roomCommandAppliedSchema,
  roomSnapshotSchema,
} from "../src/index.js";

const snapshot = {
  roomId: "eb998c91-6b4f-4984-b29d-bb26a43f10fa",
  revision: 0,
  status: "active",
  mode: "idle",
  media: null,
  live: null,
  transport: null,
  hostMemberId: "c48a185e-264f-40a9-9f4a-9d1d0186227d",
  members: [],
  serverNowMs: 1_780_000_000_000,
};

describe("additive player protocol contracts", () => {
  it("still accepts a legacy snapshot without capabilities or command cause", () => {
    expect(roomSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("keeps the applied revision separate from the current authority", () => {
    const receipt = roomCommandAppliedSchema.parse({
      commandId: "a9875c47-b2e5-479f-918d-10f8c5f100ac",
      revision: 1,
      snapshot: { ...snapshot, revision: 1 },
      currentSnapshot: { ...snapshot, revision: 3 },
    });
    expect(receipt.revision).toBe(1);
    expect(receipt.currentSnapshot.revision).toBe(3);
  });

  it("keeps unavailable observations null and rejects unknown or unbounded fields", () => {
    const report = {
      mode: "live",
      state: "playing",
      positionSec: null,
      revision: 1,
      fps: null,
    };
    expect(playbackStatusSchema.parse(report)).toEqual(report);
    expect(playbackStatusSchema.safeParse({ ...report, fps: 0 }).success).toBe(
      true,
    );
    for (const invalid of [
      { memberId: snapshot.hostMemberId },
      { signedUrl: "https://private.example.test/?token=secret" },
      { path: "/private/source.mkv" },
      { fps: Number.NaN },
      { positionSec: Number.POSITIVE_INFINITY },
      { readyState: 5 },
    ]) {
      expect(
        playbackStatusSchema.safeParse({ ...report, ...invalid }).success,
      ).toBe(false);
    }
  });
});
