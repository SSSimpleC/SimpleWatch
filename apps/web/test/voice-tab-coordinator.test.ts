import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceTabCoordinator } from "../src/voice/tab-coordinator.js";
import { installVoiceBrowser } from "./voice-fakes.js";

const coordinators: VoiceTabCoordinator[] = [];
function owner(account: string, onYield = () => Promise.resolve()) {
  const coordinator = new VoiceTabCoordinator(account, onYield);
  coordinators.push(coordinator);
  return coordinator;
}

beforeEach(() => {
  vi.useFakeTimers();
  installVoiceBrowser();
});
afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) await coordinator.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("voice tab coordination", () => {
  it("separates accounts but serializes each account across rooms/tabs", async () => {
    const first = owner("account-one");
    const second = owner("account-one");
    const different = owner("account-two");
    expect(await first.acquire()).toBe(true);
    expect(await second.acquire()).toBe(false);
    expect(await different.acquire()).toBe(true);
    await first.dispose();
    expect(await second.acquire()).toBe(true);
  });

  it("waits for the previous owner to finish audio cleanup before handing over", async () => {
    let release!: () => void;
    const yielded = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = owner("one", yielded);
    const second = owner("one");
    await first.acquire();
    let acquired = false;
    const next = second.acquire(true).then((value) => {
      acquired = value;
      return value;
    });
    await Promise.resolve();
    expect(yielded).toHaveBeenCalledOnce();
    expect(acquired).toBe(false);
    expect(first.owned).toBe(true);
    release();
    expect(await next).toBe(true);
    expect(first.owned).toBe(false);
  });

  it("does not steal from a frozen owner; takeover times out safely", async () => {
    const first = owner("one", () => new Promise(() => undefined));
    const second = owner("one");
    await first.acquire();
    const next = second.acquire(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await next).toBe(false);
    expect(first.owned).toBe(true);
    expect(second.owned).toBe(false);
  });

  it("cancels a pending explicit handoff when the requester leaves", async () => {
    const first = owner("one", () => new Promise(() => undefined));
    const second = owner("one");
    await first.acquire();
    const request = second.acquire(true);
    await second.dispose();
    expect(await request).toBe(false);
    expect(first.owned).toBe(true);
  });

  it("does not release ownership after failed cleanup", async () => {
    const first = owner("one", () =>
      Promise.reject(new Error("cleanup failed")),
    );
    const second = owner("one");
    await first.acquire();
    const request = second.acquire(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await request).toBe(false);
    expect(first.owned).toBe(true);
  });

  it("turns synchronous platform lock errors into a safe refusal", async () => {
    vi.stubGlobal("navigator", {
      locks: {
        request: () => {
          throw new DOMException("policy", "SecurityError");
        },
      },
    });
    expect(await owner("one").acquire()).toBe(false);
  });
});
