import { describe, expect, it } from "vitest";

import { moveDirectoryToQuarantine } from "../src/services/edge-eviction-service.js";

describe("moveDirectoryToQuarantine", () => {
  it("copies through a temporary quarantine directory when Docker reports EXDEV", () => {
    const calls: string[] = [];
    const source = "/media/cache";
    const destination = "/trash/edge-quarantine/job-cache";

    moveDirectoryToQuarantine(source, destination, {
      rename(from, to) {
        calls.push(`rename:${from}:${to}`);
        if (from === source && to === destination) {
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
      },
      copy(from, to) {
        calls.push(`copy:${from}:${to}`);
      },
      remove(path) {
        calls.push(`remove:${path}`);
      },
    });

    expect(calls[0]).toBe(`rename:${source}:${destination}`);
    expect(calls[1]).toMatch(
      new RegExp(`^copy:${source}:${destination}\\.[0-9a-f-]+\\.tmp$`),
    );
    expect(calls[2]).toMatch(
      new RegExp(`^rename:${destination}\\.[0-9a-f-]+\\.tmp:${destination}$`),
    );
    expect(calls[3]).toBe(`remove:${source}`);
  });

  it("retains the completed quarantine copy when source removal fails", () => {
    const calls: string[] = [];
    const source = "/media/cache";
    const destination = "/trash/edge-quarantine/job-cache";

    expect(() =>
      moveDirectoryToQuarantine(source, destination, {
        rename(from, to) {
          calls.push(`rename:${from}:${to}`);
          if (from === source && to === destination) {
            throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
          }
        },
        copy(from, to) {
          calls.push(`copy:${from}:${to}`);
        },
        remove(path) {
          calls.push(`remove:${path}`);
          if (path === source) throw new Error("source removal failed");
        },
      }),
    ).toThrow("source removal failed");

    expect(calls).toContain(`remove:${source}`);
    expect(calls).not.toContain(`remove:${destination}`);
  });
});
