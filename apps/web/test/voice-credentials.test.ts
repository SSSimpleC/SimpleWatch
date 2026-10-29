import { afterEach, describe, expect, it, vi } from "vitest";

import {
  requestVoiceCredentials,
  type VoiceCredentialContext,
} from "../src/voice-credentials.js";

const expected = {
  accountId: "account-a",
  roomId: "room-a",
  memberId: "member-a",
};
const credential = {
  url: "wss://local.invalid/rtc",
  token: "test-only-opaque-token",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("voice credential lifecycle", () => {
  it("uses the latest token and only retries an explicit CSRF mismatch once", async () => {
    let context: VoiceCredentialContext = { ...expected, csrf: "old" };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ error: { code: "CSRF_INVALID" } }, { status: 401 }),
      )
      .mockResolvedValueOnce(
        Response.json({
          account: {
            id: expected.accountId,
            username: "Simple",
            role: "viewer",
          },
          memberId: expected.memberId,
          csrfToken: "fresh",
          snapshot: { roomId: expected.roomId, status: "active" },
        }),
      )
      .mockResolvedValueOnce(Response.json(credential));
    vi.stubGlobal("fetch", fetch);
    expect(
      await requestVoiceCredentials(
        expected,
        new AbortController().signal,
        () => context,
        (bootstrap) => {
          context = { ...context, csrf: bootstrap.csrfToken };
        },
      ),
    ).toEqual(credential);
    expect(fetch).toHaveBeenCalledTimes(3);
    const init = fetch.mock.calls[2]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("x-csrf-token")).toBe("fresh");
    expect(init.credentials).toBe("same-origin");
  });

  it("does not re-enter or refresh for invalid seats or arbitrary authorization failure", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 }),
      );
    vi.stubGlobal("fetch", fetch);
    const bootstrap = vi.fn();
    await expect(
      requestVoiceCredentials(
        expected,
        new AbortController().signal,
        () => ({ ...expected, csrf: "old" }),
        bootstrap,
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("does not loop when another tab invalidates the refreshed CSRF again", async () => {
    const fetch = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve(
          Response.json({ error: { code: "CSRF_INVALID" } }, { status: 401 }),
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          account: { id: expected.accountId },
          memberId: expected.memberId,
          snapshot: { roomId: expected.roomId, status: "active" },
          csrfToken: "fresh",
        }),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(
          Response.json({ error: { code: "CSRF_INVALID" } }, { status: 401 }),
        ),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(
      requestVoiceCredentials(
        expected,
        new AbortController().signal,
        () => ({ ...expected, csrf: "csrf" }),
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: "CSRF_INVALID" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("rejects a late response after departure instead of opening a stale connection", async () => {
    let context: VoiceCredentialContext | null = { ...expected, csrf: "csrf" };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        context = null;
        return Promise.resolve(Response.json(credential));
      }),
    );
    await expect(
      requestVoiceCredentials(
        expected,
        new AbortController().signal,
        () => context,
        () => undefined,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects a bootstrap for another account without applying it", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ error: { code: "CSRF_INVALID" } }, { status: 401 }),
        )
        .mockResolvedValueOnce(
          Response.json({
            account: { id: "other" },
            memberId: expected.memberId,
            snapshot: { roomId: expected.roomId, status: "active" },
            csrfToken: "fresh",
          }),
        ),
    );
    const accept = vi.fn();
    await expect(
      requestVoiceCredentials(
        expected,
        new AbortController().signal,
        () => ({ ...expected, csrf: "csrf" }),
        accept,
      ),
    ).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    expect(accept).not.toHaveBeenCalled();
  });

  it("aborts stalled credential requests after ten seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_path: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Timed out", "AbortError")),
              { once: true },
            );
          }),
      ),
    );
    const result = requestVoiceCredentials(
      expected,
      new AbortController().signal,
      () => ({ ...expected, csrf: "csrf" }),
      () => undefined,
    );
    const rejected = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
