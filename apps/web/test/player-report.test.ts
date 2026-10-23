import { describe, expect, it } from "vitest";
import {
  buildPlayerReport,
  readPlayerReportStorage,
  serializePlayerReport,
} from "../src/player-report.js";

const buildId = "a".repeat(64);
describe("bounded local playback report", () => {
  it("exports live measurements and trace without identities or free text", () => {
    const secret = "sensitive-user-path-url-token";
    const text = serializePlayerReport({
      buildId,
      online: true,
      visibility: "visible",
      room: { roomId: secret, nickname: secret, revision: 8, connected: true },
      program: {
        mediaId: secret,
        url: secret,
        token: secret,
        cookie: secret,
        codec: "hevc",
        playbackRate: 1.05,
        bufferedAheadSec: 15,
        positionDriftSec: 1.4,
        effects: { rateWrites: 2, seekWrites: 0, lastAction: "rate:drift" },
      },
      controller: {
        mediaId: secret,
        phase: "playing",
        driftSec: 1.4,
        error: secret,
      },
      trace: [
        {
          event: "rate-requested",
          commandId: secret,
          mediaId: secret,
          playbackRate: 1,
          requestedRate: 1.05,
          bufferedAheadSec: 14,
          readyState: 4,
          frameAgeMs: 13,
          token: secret,
        },
        { event: secret, actionReason: secret },
      ],
      live: { protocol: secret, sdp: secret, ice: secret, rttMs: 63 },
    });
    expect(text).not.toContain(secret);
    expect(text).not.toMatch(
      /"(?:mediaId|roomId|commandId|nickname|token|url|cookie|sdp|ice)"/,
    );
    expect(JSON.parse(text)).toMatchObject({
      buildId,
      program: {
        playbackRate: 1.05,
        bufferedAheadSec: 15,
        effects: { rateWrites: 2, lastAction: "rate:drift" },
      },
      trace: [
        { event: "rate-requested", requestedRate: 1.05 },
        { event: "other", actionReason: null },
      ],
    });
  });

  it("bounds trace length, output size and arbitrary numbers/text", () => {
    const report = buildPlayerReport({
      buildId,
      trace: Array.from({ length: 1000 }, (_, index) => ({
        event: "x".repeat(100_000),
        revision: index,
        requestedRate: Infinity,
        positionSec: NaN,
        actionReason: "a".repeat(300),
      })),
    });
    expect(report.trace).toHaveLength(120);
    expect(report.trace[0]?.revision).toBe(880);
    expect(report.trace[119]).toMatchObject({
      event: "other",
      requestedRate: null,
      positionSec: null,
      actionReason: null,
    });
    const text = serializePlayerReport({ buildId, trace: report.trace });
    expect(text.length).toBeLessThanOrEqual(64 * 1024);
    expect(text).not.toContain("xxxxxxxx");
  });

  it("does not export an arbitrary build or controller error string", () => {
    const report = buildPlayerReport({
      buildId: "https://secret.test/token",
      controller: { error: "/home/private/file.mkv", phase: "playing" },
    });
    expect(report.buildId).toBe("unavailable");
    expect(report.controller.hasError).toBe(true);
    expect(report.controller.errorCode).toBeNull();
    expect(JSON.stringify(report)).not.toMatch(/secret|private|\.mkv/);
  });

  it("retains only the controller's fixed failure codes", () => {
    for (const code of [
      "media-playback-error",
      "seek-no-progress",
      "seek-target-not-reached",
      "seek-request-failed",
      "sync-recovery-budget-exhausted",
    ]) {
      const report = buildPlayerReport({
        buildId,
        controller: { error: code },
      });
      expect(report.controller.errorCode).toBe(code);
      expect(report.controller.hasError).toBe(true);
    }
    expect(
      buildPlayerReport({
        buildId,
        controller: { error: "media-https://private.test/?token=secret" },
      }).controller.errorCode,
    ).toBeNull();
  });

  it("handles malformed, missing, oversized and unavailable storage", () => {
    expect(readPlayerReportStorage(null)).toEqual({
      room: null,
      program: null,
      live: null,
      trace: null,
    });
    expect(
      readPlayerReportStorage({
        getItem: () => {
          throw new Error("denied");
        },
      }),
    ).toEqual(readPlayerReportStorage(null));
    expect(readPlayerReportStorage({ getItem: () => "{" })).toEqual(
      readPlayerReportStorage(null),
    );
    expect(
      readPlayerReportStorage({ getItem: () => "x".repeat(128 * 1024 + 1) }),
    ).toEqual(readPlayerReportStorage(null));
    const snapshot = readPlayerReportStorage({
      getItem: (key) =>
        key.endsWith("playback-trace")
          ? '[{"event":"rate-requested","requestedRate":1.05}]'
          : null,
    });
    expect(
      buildPlayerReport({ buildId, ...snapshot }).trace[0]?.requestedRate,
    ).toBe(1.05);
  });
});
