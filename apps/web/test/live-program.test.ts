import { describe, expect, it, vi } from "vitest";

import { decideProgramTrack, replaceRetryTimer } from "../src/live-program.js";

describe("live program track lifecycle", () => {
  it("accepts exactly one live track of each kind and rejects a duplicate", () => {
    const audio = { id: "audio-1", kind: "audio", readyState: "live" };
    expect(decideProgramTrack(undefined, audio)).toBe("accept");
    expect(decideProgramTrack(audio, audio)).toBe("same");
    expect(
      decideProgramTrack(audio, {
        id: "audio-2",
        kind: "audio",
        readyState: "live",
      }),
    ).toBe("reject-duplicate");
    expect(
      decideProgramTrack(
        { ...audio, readyState: "ended" },
        { id: "audio-2", kind: "audio", readyState: "live" },
      ),
    ).toBe("accept");
  });

  it("replaces the previous retry timer instead of stacking retries", () => {
    const clearTimer = vi.fn();
    const schedule = vi.fn(() => 22);
    const retry = vi.fn();

    const timer = replaceRetryTimer(11, clearTimer, schedule, retry, 2_000);

    expect(clearTimer).toHaveBeenCalledWith(11);
    expect(schedule).toHaveBeenCalledWith(retry, 2_000);
    expect(timer).toBe(22);
  });
});
