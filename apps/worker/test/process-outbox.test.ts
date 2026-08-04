import { describe, expect, it, vi } from "vitest";

import {
  processOutboxItem,
  reconcileRtcParticipants,
  type LiveKitRoomAdmin,
} from "../src/process-outbox.js";

const roomId = "0198a1c2-4b20-7a11-8000-000000000001";
const memberId = "0198a1c2-4b20-7a11-8000-000000000002";

describe("processOutboxItem", () => {
  it("removes and revokes a kicked LiveKit participant", async () => {
    // Arrange
    const removeParticipant = vi.fn(() => Promise.resolve());
    const livekit: LiveKitRoomAdmin = { removeParticipant };

    // Act
    await processOutboxItem(
      {
        id: "outbox-1",
        kind: "rtc.remove-participant",
        payload: { roomId, memberId },
        leaseToken: "lease",
      },
      {
        livekit,
        mediamtxControlUrl: "http://127.0.0.1:9997",
      },
    );

    // Assert
    expect(removeParticipant).toHaveBeenCalledOnce();
    expect(removeParticipant).toHaveBeenCalledWith(`voice:${roomId}`, memberId);
  });

  it("removes participants missing from the authoritative membership snapshot", async () => {
    // Arrange
    const removeParticipant = vi.fn(() => Promise.resolve());
    const listParticipants = vi.fn(() =>
      Promise.resolve([
        { identity: memberId },
        { identity: "0198a1c2-4b20-7a11-8000-000000000003" },
      ]),
    );

    // Act
    const removed = await reconcileRtcParticipants(
      [{ roomId, activeMemberIds: [memberId] }],
      { listParticipants, removeParticipant },
    );

    // Assert
    expect(removed).toBe(1);
    expect(removeParticipant).toHaveBeenCalledWith(
      `voice:${roomId}`,
      "0198a1c2-4b20-7a11-8000-000000000003",
    );
  });

  it("kicks every recorded MediaMTX session and accepts an already-gone session", async () => {
    // Arrange
    const requests: string[] = [];
    const fetchImpl = vi.fn((input: URL | RequestInfo) => {
      requests.push(
        input instanceof URL
          ? input.toString()
          : typeof input === "string"
            ? input
            : input.url,
      );
      return Promise.resolve(
        new Response(null, {
          status: requests.length === 1 ? 204 : 404,
        }),
      );
    }) as unknown as typeof fetch;

    // Act
    await processOutboxItem(
      {
        id: "outbox-2",
        kind: "mediamtx.kick-sessions",
        payload: {
          roomId,
          memberId,
          sessionIds: ["session/a", "gone", "session/a"],
        },
        leaseToken: "lease",
      },
      {
        livekit: { removeParticipant: vi.fn(() => Promise.resolve()) },
        mediamtxControlUrl: "http://127.0.0.1:9997",
        fetchImpl,
      },
    );

    // Assert
    expect(requests).toEqual([
      "http://127.0.0.1:9997/v3/webrtcsessions/kick/session%2Fa",
      "http://127.0.0.1:9997/v3/webrtcsessions/kick/gone",
    ]);
  });

  it("accepts a legacy 512-session payload while limiting each concurrent batch to 32", async () => {
    // Arrange
    const sessionIds = Array.from(
      { length: 512 },
      (_, index) => `legacy-session-${index}`,
    );
    let inFlight = 0;
    let maxInFlight = 0;
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      requests.push(
        input instanceof URL
          ? input.toString()
          : typeof input === "string"
            ? input
            : input.url,
      );
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    // Act
    await processOutboxItem(
      {
        id: "legacy-outbox",
        kind: "mediamtx.kick-sessions",
        payload: { roomId, memberId, sessionIds },
        leaseToken: "lease",
      },
      {
        livekit: { removeParticipant: vi.fn(() => Promise.resolve()) },
        mediamtxControlUrl: "http://127.0.0.1:9997",
        fetchImpl,
      },
    );

    // Assert
    expect(requests).toHaveLength(512);
    expect(new Set(requests).size).toBe(512);
    expect(maxInFlight).toBe(32);
  });

  it("fails the lease attempt when MediaMTX rejects a kick", async () => {
    // Arrange
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 503 })),
    );

    // Act
    const operation = processOutboxItem(
      {
        id: "outbox-3",
        kind: "mediamtx.kick-sessions",
        payload: { roomId, memberId, sessionIds: ["session-1"] },
        leaseToken: "lease",
      },
      {
        livekit: { removeParticipant: vi.fn(() => Promise.resolve()) },
        mediamtxControlUrl: "http://127.0.0.1:9997",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );

    // Assert
    await expect(operation).rejects.toThrow("HTTP 503");
  });
});
