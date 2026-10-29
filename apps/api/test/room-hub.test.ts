import { afterEach, describe, expect, it, vi } from "vitest";

import { RoomHub } from "../src/room-hub.js";

const hubs: RoomHub[] = [];

afterEach(() => {
  for (const hub of hubs.splice(0)) hub.dispose();
});

function createHub() {
  const hub = new RoomHub();
  hubs.push(hub);
  return hub;
}

function socket() {
  return { readyState: 1, close: vi.fn(), send: vi.fn() };
}

function access(authorize: () => boolean) {
  return { role: "member" as const, nickname: "Viewer", authorize };
}

describe("RoomHub broadcast authorization", () => {
  it("revalidates every send and excludes a revoked connection immediately", () => {
    const hub = createHub();
    const revoked = socket();
    const current = socket();
    let authorized = true;
    hub.add(
      "room",
      "old",
      revoked,
      access(() => authorized),
    );
    hub.add(
      "room",
      "current",
      current,
      access(() => true),
    );
    const payload = { type: "room.snapshot", revision: 4, transport: null };

    hub.broadcast("room", payload);
    expect(revoked.send).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify(payload),
    );
    authorized = false;
    revoked.send.mockClear();
    current.send.mockClear();
    hub.broadcast("room", payload);

    expect(revoked.send).not.toHaveBeenCalled();
    expect(revoked.close).toHaveBeenCalledExactlyOnceWith(
      4001,
      "session invalid",
    );
    expect(current.send).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify(payload),
    );
  });

  it("fails closed on authorization errors without blocking later peers", () => {
    const hub = createHub();
    const broken = socket();
    broken.close.mockImplementation(() => {
      throw new Error("close failure");
    });
    const current = socket();
    hub.add(
      "room",
      "broken",
      broken,
      access(() => {
        throw new Error("authorization failure");
      }),
    );
    hub.add(
      "room",
      "current",
      current,
      access(() => true),
    );

    expect(() => hub.broadcast("room", { revision: 1 })).not.toThrow();
    expect(broken.send).not.toHaveBeenCalled();
    expect(broken.close).toHaveBeenCalledWith(4001, "session invalid");
    expect(current.send).toHaveBeenCalledExactlyOnceWith('{"revision":1}');
  });

  it("isolates a send failure and retains optional-access compatibility", () => {
    const hub = createHub();
    const broken = socket();
    broken.send.mockImplementation(() => {
      throw new Error("send failure");
    });
    const legacy = socket();
    const closed = socket();
    closed.readyState = 3;
    const validateClosed = vi.fn(() => true);
    hub.add(
      "room",
      "broken",
      broken,
      access(() => true),
    );
    hub.add("room", "legacy", legacy);
    hub.add("room", "closed", closed, access(validateClosed));

    expect(() => hub.broadcast("room", { revision: 2 })).not.toThrow();
    expect(broken.close).toHaveBeenCalledWith(1011, "send failed");
    expect(legacy.send).toHaveBeenCalledExactlyOnceWith('{"revision":2}');
    expect(closed.send).not.toHaveBeenCalled();
    expect(validateClosed).not.toHaveBeenCalled();
  });
});
