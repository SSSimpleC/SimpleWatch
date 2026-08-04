import { describe, expect, it } from "vitest";

import { fullJitterBackoff } from "../src/backoff.js";

describe("Edge Agent 网络退避", () => {
  it("使用full-jitter并把指数上限限制为十五分钟", () => {
    expect(fullJitterBackoff(1, () => 0)).toBe(0);
    expect(fullJitterBackoff(1, () => 1)).toBe(2_000);
    expect(fullJitterBackoff(30, () => 1)).toBe(15 * 60 * 1000);
    expect(fullJitterBackoff(30, () => 0.5)).toBe(7.5 * 60 * 1000);
  });
});
