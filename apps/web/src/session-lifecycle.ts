import type { QueryClient } from "@tanstack/react-query";

import { api, ApiError, type AccountSession } from "./api.js";
import { purgeNonAudioStorage } from "./preferences.js";
import { useSession } from "./store.js";
import {
  currentSessionGeneration,
  invalidateSessionOperations,
} from "./session-generation.js";

export const SESSION_RELEASE_EVENT = "simplewatch:session-release";
export const SESSION_CHANNEL = "simplewatch:session-lifecycle.v1";

/** Stop local capture immediately, even if the server logout request fails. */
export function releaseSessionMedia(): void {
  window.dispatchEvent(new Event(SESSION_RELEASE_EVENT));
  for (const element of document.querySelectorAll("video, audio")) {
    const media = element as HTMLMediaElement;
    media.pause();
    media.srcObject = null;
    media.removeAttribute("src");
    media.load();
  }
}

export function clearLocalSession(queryClient: QueryClient): void {
  invalidateSessionOperations();
  releaseSessionMedia();
  void queryClient.cancelQueries().catch(() => undefined);
  queryClient.clear();
  useSession.getState().clear();
  purgeNonAudioStorage();
}

let pendingLogout: Promise<void> | null = null;

/** Share one request across repeated clicks; never fake success after a network error. */
export function logoutAccount(queryClient: QueryClient): Promise<void> {
  if (pendingLogout) return pendingLogout;
  const work = performLogout(queryClient);
  pendingLogout = work;
  void work.then(
    () => {
      if (pendingLogout === work) pendingLogout = null;
    },
    () => {
      if (pendingLogout === work) pendingLogout = null;
    },
  );
  return work;
}

async function performLogout(queryClient: QueryClient): Promise<void> {
  releaseSessionMedia();
  const accountId = useSession.getState().account?.id;
  const generation = currentSessionGeneration();
  let csrf = useSession.getState().adminCsrf;
  if (!accountId || !csrf)
    throw new ApiError(
      401,
      "SESSION_UNAVAILABLE",
      "尚未确认登录状态，请刷新后重试退出",
    );

  const assertCurrent = () => {
    const current = useSession.getState().account;
    if (current?.id !== accountId || generation !== currentSessionGeneration())
      throw new ApiError(
        401,
        "SESSION_CHANGED",
        "账户已变化，请刷新确认当前登录状态",
      );
  };

  const finish = () => {
    assertCurrent();
    clearLocalSession(queryClient);
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(SESSION_CHANNEL);
      channel.postMessage({ type: "logout", version: 1 });
      channel.close();
    }
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      assertCurrent();
      await api<void>("/api/v1/auth/logout", {
        method: "POST",
        headers: { "x-csrf-token": csrf },
        body: "{}",
        signal: AbortSignal.timeout(10_000),
      });
      finish();
      return;
    } catch (error) {
      // In particular, a new login of the SAME account is a different session.
      // Never recover its CSRF token and use it to retry an older logout.
      assertCurrent();
      // A previous response can have been lost after server-side revocation.
      // Only this explicit server auth rejection proves the session is no longer valid.
      if (
        error instanceof ApiError &&
        error.status === 401 &&
        error.code === "UNAUTHORIZED"
      ) {
        finish();
        return;
      }
      if (
        !(error instanceof ApiError) ||
        error.code !== "CSRF_INVALID" ||
        attempt > 0
      )
        throw error;
      let session: AccountSession;
      try {
        assertCurrent();
        session = await api<AccountSession>("/api/v1/auth/session", {
          signal: AbortSignal.timeout(10_000),
        });
      } catch (recoveryError) {
        assertCurrent();
        if (
          recoveryError instanceof ApiError &&
          recoveryError.status === 401 &&
          recoveryError.code === "UNAUTHORIZED"
        ) {
          finish();
          return;
        }
        throw recoveryError;
      }
      assertCurrent();
      if (
        session.account.id !== accountId ||
        useSession.getState().account?.id !== accountId
      )
        throw new ApiError(
          401,
          "SESSION_CHANGED",
          "账户已变化，请刷新后再退出",
        );
      csrf = session.csrfToken;
      useSession.getState().setAdminCsrf(csrf);
    }
  }
}
