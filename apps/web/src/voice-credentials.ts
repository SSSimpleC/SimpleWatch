import {
  api,
  ApiError,
  type AccountSession,
  type RoomSnapshot,
} from "./api.js";

export interface VoiceBootstrap {
  account: AccountSession["account"];
  snapshot: RoomSnapshot;
  memberId: string;
  csrfToken: string;
}

export interface VoiceCredentialContext {
  accountId: string;
  roomId: string;
  memberId: string;
  csrf: string | null;
}

/** One owner, one timed request and at most one explicit CSRF recovery. */
export async function requestVoiceCredentials(
  expected: Omit<VoiceCredentialContext, "csrf">,
  signal: AbortSignal,
  current: () => VoiceCredentialContext | null,
  acceptBootstrap: (value: VoiceBootstrap) => void,
): Promise<{ url: string; token: string }> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const assertCurrent = () => {
    controller.signal.throwIfAborted();
    const value = current();
    if (
      !value ||
      value.accountId !== expected.accountId ||
      value.roomId !== expected.roomId ||
      value.memberId !== expected.memberId
    )
      throw new DOMException("语音会话已结束", "AbortError");
    return value;
  };
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const context = assertCurrent();
      if (!context.csrf)
        throw new ApiError(401, "SESSION_UNAVAILABLE", "房间身份尚未就绪");
      try {
        const credential = await api<{ url: string; token: string }>(
          `/api/v1/rooms/${expected.roomId}/credentials`,
          {
            method: "POST",
            headers: { "x-csrf-token": context.csrf },
            body: JSON.stringify({ purpose: "voice" }),
            signal: controller.signal,
          },
        );
        assertCurrent();
        return credential;
      } catch (error) {
        if (
          !(error instanceof ApiError) ||
          error.code !== "CSRF_INVALID" ||
          attempt !== 0
        )
          throw error;
        const bootstrap = await api<VoiceBootstrap>(
          `/api/v1/rooms/${expected.roomId}/bootstrap`,
          { signal: controller.signal },
        );
        assertCurrent();
        if (
          bootstrap.account.id !== expected.accountId ||
          bootstrap.memberId !== expected.memberId ||
          bootstrap.snapshot.roomId !== expected.roomId ||
          bootstrap.snapshot.status !== "active"
        )
          throw new ApiError(
            401,
            "SESSION_CHANGED",
            "席位已变化，请返回门厅确认",
          );
        acceptBootstrap(bootstrap);
      }
    }
    throw new Error("语音凭据刷新失败，请重试");
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}
