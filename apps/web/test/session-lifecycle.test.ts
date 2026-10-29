import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearLocalSession,
  logoutAccount,
  SESSION_RELEASE_EVENT,
} from "../src/session-lifecycle.js";
import { useSession } from "../src/store.js";
import {
  currentSessionGeneration,
  invalidateSessionOperations,
} from "../src/session-generation.js";

class MemoryStorage implements Storage {
  private items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  clear() {
    this.items.clear();
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  setItem(key: string, value: string) {
    this.items.set(key, String(value));
  }
}

beforeEach(() => {
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", { querySelectorAll: () => [] });
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("sessionStorage", new MemoryStorage());
  vi.stubGlobal("BroadcastChannel", undefined);
  useSession
    .getState()
    .setAccount({ id: "account-a", username: "Simple", role: "viewer" });
  useSession.getState().setAdminCsrf("csrf-a");
});
afterEach(() => {
  useSession.getState().clear();
  vi.unstubAllGlobals();
});

describe("logout privacy and preference boundary", () => {
  it("shares repeated clicks and accepts explicit already-revoked sessions", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 }),
      );
    vi.stubGlobal("fetch", fetch);
    const queries = new QueryClient();
    const first = logoutAccount(queries);
    const second = logoutAccount(queries);
    expect(first).toBe(second);
    await first;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(useSession.getState().account).toBeNull();
  });

  it("does not let a late logout clear a newly selected account", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        useSession
          .getState()
          .setAccount({ id: "account-b", username: "FJ233", role: "viewer" });
        return Promise.resolve(new Response(null, { status: 204 }));
      }),
    );
    await expect(logoutAccount(new QueryClient())).rejects.toMatchObject({
      code: "SESSION_CHANGED",
    });
    expect(useSession.getState().account?.id).toBe("account-b");
  });

  it("does not start CSRF recovery after the same account logs in again", async () => {
    const fetch = vi.fn(() => {
      invalidateSessionOperations();
      useSession.getState().setAdminCsrf("new-session-csrf");
      return Promise.resolve(
        Response.json({ error: { code: "CSRF_INVALID" } }, { status: 401 }),
      );
    });
    vi.stubGlobal("fetch", fetch);
    await expect(logoutAccount(new QueryClient())).rejects.toMatchObject({
      code: "SESSION_CHANGED",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(useSession.getState().account?.id).toBe("account-a");
    expect(useSession.getState().adminCsrf).toBe("new-session-csrf");
  });

  it("does not retry logout with the new session token returned by delayed recovery", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ error: { code: "CSRF_INVALID" } }, { status: 401 }),
      )
      .mockImplementationOnce(() => {
        invalidateSessionOperations();
        useSession.getState().setAdminCsrf("new-session-csrf");
        return Promise.resolve(
          Response.json({
            account: { id: "account-a" },
            csrfToken: "recovery-from-new-session",
          }),
        );
      });
    vi.stubGlobal("fetch", fetch);
    await expect(logoutAccount(new QueryClient())).rejects.toMatchObject({
      code: "SESSION_CHANGED",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(useSession.getState().adminCsrf).toBe("new-session-csrf");
    expect(useSession.getState().account?.id).toBe("account-a");
  });

  it("does not invalidate a new pending login even when its account is not populated yet", async () => {
    let latestGeneration = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        useSession.getState().clear();
        latestGeneration = invalidateSessionOperations();
        return Promise.resolve(new Response(null, { status: 204 }));
      }),
    );
    await expect(logoutAccount(new QueryClient())).rejects.toMatchObject({
      code: "SESSION_CHANGED",
    });
    expect(currentSessionGeneration()).toBe(latestGeneration);
  });

  it("recovers an unchanged session CSRF once and completes its logout", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ error: { code: "CSRF_INVALID" } }, { status: 401 }),
      )
      .mockResolvedValueOnce(
        Response.json({
          account: { id: "account-a" },
          csrfToken: "refreshed-csrf",
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    await logoutAccount(new QueryClient());
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(
      (fetch.mock.calls[2]?.[1] as RequestInit | undefined)?.headers,
    ).toBeInstanceOf(Headers);
    expect(
      new Headers(
        (fetch.mock.calls[2]?.[1] as RequestInit | undefined)?.headers,
      ).get("x-csrf-token"),
    ).toBe("refreshed-csrf");
    expect(useSession.getState().account).toBeNull();
  });

  it("stops capture before attempting logout but does not fake success on network failure", async () => {
    const release = vi.fn();
    window.addEventListener(SESSION_RELEASE_EVENT, release);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        expect(release).toHaveBeenCalledTimes(1);
        return Promise.reject(new Error("offline"));
      }),
    );
    const queryClient = new QueryClient();
    await expect(logoutAccount(queryClient)).rejects.toThrow("offline");
    expect(useSession.getState().account?.id).toBe("account-a");
    queryClient.clear();
  });

  it("clears in-memory auth, media and diagnostics only after server logout success", async () => {
    const video = {
      pause: vi.fn(),
      removeAttribute: vi.fn(),
      load: vi.fn(),
      srcObject: {},
    };
    vi.stubGlobal("document", { querySelectorAll: () => [video] });
    sessionStorage.setItem("simplewatch.room-state", "private-room-state");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    );
    const queryClient = new QueryClient();
    queryClient.setQueryData(["room-media"], { id: "private-media" });
    await logoutAccount(queryClient);
    expect(useSession.getState().account).toBeNull();
    expect(queryClient.getQueryData(["room-media"])).toBeUndefined();
    expect(sessionStorage.getItem("simplewatch.room-state")).toBeNull();
    expect(video.pause).toHaveBeenCalled();
    expect(video.removeAttribute).toHaveBeenCalledWith("src");
    expect(video.srcObject).toBeNull();
    expect(video.load).toHaveBeenCalled();
  });

  it("a cross-tab logout clears this tab's session without sending another server request", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    clearLocalSession(new QueryClient());
    expect(useSession.getState().account).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
