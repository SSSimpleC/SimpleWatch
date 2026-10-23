import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

describe("online-only player service worker", () => {
  it("retires only SimpleWatch shell caches and never intercepts fetch or reloads clients", async () => {
    const callbacks = new Map<
      string,
      (event: { waitUntil: (promise: Promise<unknown>) => void }) => void
    >();
    const remove = vi.fn().mockResolvedValue(true);
    const claim = vi.fn().mockResolvedValue(undefined);
    const skipWaiting = vi.fn().mockResolvedValue(undefined);
    runInNewContext(
      readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"),
      {
        self: {
          addEventListener: (
            name: string,
            callback: typeof callbacks extends Map<string, infer T> ? T : never,
          ) => callbacks.set(name, callback),
          skipWaiting,
          clients: { claim },
        },
        caches: {
          keys: () =>
            Promise.resolve([
              "simplewatch-shell-v1",
              "simplewatch-shell-v0",
              "another-app-cache",
              "media-data",
            ]),
          delete: remove,
        },
      },
    );
    expect([...callbacks.keys()]).toEqual(["install", "activate"]);
    const work: Promise<unknown>[] = [];
    callbacks.get("install")?.({ waitUntil: (promise) => work.push(promise) });
    callbacks.get("activate")?.({ waitUntil: (promise) => work.push(promise) });
    await Promise.all(work);
    expect(skipWaiting).toHaveBeenCalledOnce();
    expect(claim).toHaveBeenCalledOnce();
    expect(remove.mock.calls).toEqual([
      ["simplewatch-shell-v1"],
      ["simplewatch-shell-v0"],
    ]);
  });
});
