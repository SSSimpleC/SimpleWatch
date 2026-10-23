import { useEffect, useState } from "react";

declare const __PLAYER_BUILD__: string;
export const PLAYER_BUILD =
  typeof __PLAYER_BUILD__ === "string" &&
  /^[a-f0-9]{64}$/.test(__PLAYER_BUILD__)
    ? __PLAYER_BUILD__
    : "development";

export function parsePlayerBuild(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const { schemaVersion, buildId } = value as {
    schemaVersion?: unknown;
    buildId?: unknown;
  };
  return schemaVersion === 1 &&
    typeof buildId === "string" &&
    /^[a-f0-9]{64}$/.test(buildId)
    ? buildId
    : null;
}

/** Public immutable identity only. No cookies, media URLs or client diagnostics
 * are sent. A version check never reloads or touches the media element. */
export class PlayerBuildMonitor {
  private lastAttempt = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<string | null> | null = null;
  private latest: string | null = null;
  private controller: AbortController | null = null;
  private disposed = false;

  public constructor(
    private readonly fetcher: typeof fetch = (input, options) =>
      globalThis.fetch(input, options),
    private readonly now: () => number = () => performance.now(),
  ) {}

  public check(): Promise<string | null> {
    if (this.disposed) return Promise.resolve(null);
    if (this.inFlight) return this.inFlight;
    const now = this.now();
    if (!Number.isFinite(now) || now - this.lastAttempt < 15_000)
      return Promise.resolve(this.latest);
    this.lastAttempt = now;
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(), 5000);
    // Native browser fetch needs its Window receiver; the default wrapper above
    // supplies it. Injected functions are called as functions, not class methods.
    // The microtask also contains synchronous dependency errors in this chain.
    const fetcher = this.fetcher;
    this.inFlight = Promise.resolve()
      .then(() =>
        fetcher("/player-version.json", {
          cache: "no-store",
          credentials: "omit",
          signal: controller.signal,
        }),
      )
      .then(async (response) => {
        if (!response.ok) return null;
        const text = await response.text();
        if (text.length > 256) return null;
        return parsePlayerBuild(JSON.parse(text) as unknown);
      })
      .then((build) => {
        if (this.disposed || controller.signal.aborted) return null;
        if (build) this.latest = build;
        return this.latest;
      })
      .catch(() => this.latest)
      .finally(() => {
        clearTimeout(timer);
        this.inFlight = null;
        this.controller = null;
      });
    return this.inFlight;
  }

  public dispose(): void {
    this.disposed = true;
    this.controller?.abort();
  }
}

export function usePlayerBuild(): string | null {
  const [latest, setLatest] = useState<string | null>(null);
  useEffect(() => {
    const monitor = new PlayerBuildMonitor();
    let active = true;
    const check = () => {
      if (document.visibilityState === "hidden") return;
      void monitor.check().then((value) => {
        if (active && value) setLatest(value);
      });
    };
    check();
    window.addEventListener("pageshow", check);
    document.addEventListener("visibilitychange", check);
    const timer = window.setInterval(check, 60_000);
    return () => {
      active = false;
      monitor.dispose();
      window.clearInterval(timer);
      window.removeEventListener("pageshow", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);
  return latest;
}
