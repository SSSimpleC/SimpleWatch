import { describe, expect, it, vi } from "vitest";
import type { RoomCommandRequest } from "@simplewatch/contracts";

import {
  RoomCommandQueue,
  type RoomCommandContext,
  type RoomCommandResult,
} from "../src/room-command-queue.js";

const context: RoomCommandContext = {
  roomId: "room",
  mediaId: "film",
  generation: 1,
};

function fixture() {
  let now = 0;
  let nextId = 0;
  const send = vi.fn<
    (request: RoomCommandRequest, context: RoomCommandContext) => boolean
  >(() => true);
  const refresh = vi.fn();
  const results: RoomCommandResult[] = [];
  const queue = new RoomCommandQueue({
    nowMs: () => now,
    serverNowMs: () => 100_000 + now,
    createId: () => `command-${++nextId}`,
    send,
    onRefresh: refresh,
    onResult: (result) => results.push(result),
  });
  queue.setContext(context, 10);
  return {
    queue,
    send,
    refresh,
    results,
    advance: (ms: number) => {
      now += ms;
      queue.tick();
    },
  };
}

describe("host room command queue", () => {
  it("serializes writes and takes the next revision from the current authoritative receipt", () => {
    const f = fixture();
    const first = f.queue.enqueue({ kind: "seek", positionSec: 20 })!;
    f.queue.enqueue({ kind: "pause" });
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0]?.[0]).toMatchObject({
      expectedRevision: 10,
      effectiveAtServerMs: 100_750,
    });
    f.queue.acknowledge(first, 11, 14);
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls[1]?.[0]).toMatchObject({
      expectedRevision: 14,
      command: { kind: "pause" },
    });
    expect(f.results[0]).toMatchObject({
      executionRevision: 11,
      currentRevision: 14,
      outcome: "applied",
    });
  });

  it("coalesces only adjacent unsent seeks and preserves intervening pause/play", () => {
    const f = fixture();
    const first = f.queue.enqueue({ kind: "seek", positionSec: 1 })!;
    const superseded = f.queue.enqueue({ kind: "seek", positionSec: 2 })!;
    const retained = f.queue.enqueue({ kind: "seek", positionSec: 3 })!;
    const pause = f.queue.enqueue({ kind: "pause" })!;
    const final = f.queue.enqueue({ kind: "seek", positionSec: 4 })!;
    f.queue.enqueue({ kind: "play" });
    expect(f.results).toContainEqual(
      expect.objectContaining({ commandId: superseded, outcome: "superseded" }),
    );
    f.queue.acknowledge(first, 11);
    f.queue.acknowledge(retained, 12);
    f.queue.acknowledge(pause, 13);
    f.queue.acknowledge(final, 14);
    expect(f.send.mock.calls.map(([request]) => request.command)).toEqual([
      { kind: "seek", positionSec: 1 },
      { kind: "seek", positionSec: 3 },
      { kind: "pause" },
      { kind: "seek", positionSec: 4 },
      { kind: "play" },
    ]);
  });

  it("retries exactly the same request once at 3 seconds without resetting its deadline", () => {
    const f = fixture();
    f.queue.enqueue({ kind: "play" });
    f.advance(2_999);
    expect(f.send).toHaveBeenCalledTimes(1);
    f.advance(1);
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls[1]?.[0]).toBe(f.send.mock.calls[0]?.[0]);
    f.advance(6_999);
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.queue.getState().frozen).toBe(false);
    f.advance(1);
    expect(f.results.at(-1)?.outcome).toBe("unknown");
    expect(f.refresh).toHaveBeenCalledTimes(1);
  });

  it("freezes on unknown, cancels unsent work, and only a fresh current-context snapshot releases it", () => {
    const f = fixture();
    const first = f.queue.enqueue({ kind: "play" })!;
    const pending = f.queue.enqueue({ kind: "pause" })!;
    f.advance(10_000);
    expect(f.queue.getState()).toMatchObject({ frozen: true, pendingIds: [] });
    expect(f.results).toContainEqual(
      expect.objectContaining({ commandId: pending, outcome: "cancelled" }),
    );
    expect(f.queue.enqueue({ kind: "seek", positionSec: 40 })).toBeNull();
    f.queue.updateRevision(15);
    f.queue.setContext(context, 15);
    expect(f.queue.getState().frozen).toBe(true);
    expect(f.queue.acknowledge(first, 11, 16)).toBe(true);
    expect(f.queue.getState()).toMatchObject({ frozen: true, revision: 15 });
    expect(
      f.queue.acceptAuthoritativeSnapshot({ ...context, generation: 0 }, 16),
    ).toBe(false);
    expect(f.queue.acceptAuthoritativeSnapshot(context, 14)).toBe(false);
    expect(f.queue.acceptAuthoritativeSnapshot(context, 16)).toBe(true);
    expect(f.queue.getPendingIds()).toEqual([]);
    f.queue.enqueue({ kind: "pause" });
    expect(f.send.mock.calls.at(-1)?.[0]).toMatchObject({
      expectedRevision: 16,
    });
  });

  it("rejects and cancels old-revision work rather than blindly pumping it", () => {
    const f = fixture();
    const first = f.queue.enqueue({ kind: "seek", positionSec: 10 })!;
    f.queue.enqueue({ kind: "pause" });
    expect(f.queue.reject(first, "REVISION_CONFLICT")).toBe(true);
    expect(f.queue.getState().frozen).toBe(true);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(f.queue.reject(first, "again")).toBe(false);
  });

  it("does not let old media or connection receipts affect a new context", () => {
    const f = fixture();
    const first = f.queue.enqueue({ kind: "play" })!;
    f.queue.enqueue({ kind: "pause" });
    f.queue.setContext({ ...context, mediaId: "next-film", generation: 2 }, 20);
    const next = f.queue.enqueue({ kind: "play" });
    expect(f.queue.acknowledge(first, 21, 99)).toBe(false);
    expect(f.queue.getState()).toMatchObject({
      revision: 20,
      pendingIds: [next],
    });
  });

  it("does not roll revision backwards when a duplicate execution receipt predates a snapshot", () => {
    const f = fixture();
    const first = f.queue.enqueue({ kind: "pause" })!;
    f.queue.updateRevision(30);
    f.queue.enqueue({ kind: "play" });
    f.queue.acknowledge(first, 11, 15);
    expect(f.send.mock.calls.at(-1)?.[0]).toMatchObject({
      expectedRevision: 30,
    });
  });

  it("treats a failed initial send as rejected, but a failed retry as unknown until deadline", () => {
    const f = fixture();
    f.send.mockReturnValueOnce(false);
    f.queue.enqueue({ kind: "play" });
    expect(f.results.at(-1)?.outcome).toBe("rejected");
    f.queue.acceptAuthoritativeSnapshot(context, 10);
    f.queue.enqueue({ kind: "play" });
    f.send.mockReturnValueOnce(false);
    f.advance(3_000);
    expect(f.queue.getPendingIds()).toHaveLength(1);
    f.advance(7_000);
    expect(f.results.at(-1)?.outcome).toBe("unknown");
  });

  it("treats transport throws as unknown and never sends queued work after reset", () => {
    const f = fixture();
    f.send.mockImplementationOnce(() => {
      throw new Error("write interrupted");
    });
    f.queue.enqueue({ kind: "play" });
    expect(f.results.at(-1)?.outcome).toBe("unknown");
    f.queue.reset();
    f.advance(20_000);
    expect(f.queue.enqueue({ kind: "play" })).toBeNull();
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("keeps the highest known room revision across reconnect or media-context changes", () => {
    const f = fixture();
    f.queue.updateRevision(30);
    f.queue.setContext({ ...context, generation: 2 }, 10);
    expect(f.queue.getState().revision).toBe(30);
    f.queue.setContext({ ...context, roomId: "other-room", generation: 3 }, 1);
    expect(f.queue.getState().revision).toBe(1);
  });
});
