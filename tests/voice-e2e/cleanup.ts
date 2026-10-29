import {
  expect,
  type APIResponse,
  type BrowserContext,
} from "@playwright/test";

const origin = "https://127.0.0.1:18443";

interface FixtureSession {
  csrfToken: string;
  account: { role: "host" | "viewer" };
}

async function errorCode(response: APIResponse): Promise<string | undefined> {
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !("error" in body)) return;
  const error = body.error;
  if (!error || typeof error !== "object" || !("code" in error)) return;
  return typeof error.code === "string" ? error.code : undefined;
}

/** Teardown only: prevent the SPA/lobby from rotating CSRF during API cleanup. */
export async function stopFixturePageActivity(contexts: BrowserContext[]) {
  for (const context of contexts)
    for (const page of context.pages()) await page.goto("about:blank");
}

async function session(
  context: BrowserContext,
): Promise<FixtureSession | null> {
  const response = await context.request.get("/api/v1/auth/session");
  if (response.status() === 401) {
    expect(await errorCode(response)).toBe("UNAUTHORIZED");
    return null;
  }
  expect(response.status()).toBe(200);
  return (await response.json()) as FixtureSession;
}

/** Never treat arbitrary 401 as success; one explicit CSRF recovery is allowed. */
export async function logoutFixtureSession(context: BrowserContext) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await session(context);
    if (!current) return;
    const response = await context.request.post("/api/v1/auth/logout", {
      headers: { origin, "x-csrf-token": current.csrfToken },
    });
    if (response.status() === 204) {
      expect(await session(context)).toBeNull();
      return;
    }
    if (response.status() === 401) {
      const code = await errorCode(response);
      if (code === "CSRF_INVALID" && attempt === 0) continue;
      if (code === "UNAUTHORIZED") {
        expect(await session(context)).toBeNull();
        return;
      }
    }
    expect(response.status()).toBe(204);
  }
  throw new Error("Fixture logout exceeded the single CSRF recovery");
}

export async function closeFixtureRoom(
  context: BrowserContext,
  roomId: string,
  allowHostLogin = false,
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let current = await session(context);
    if (!current && allowHostLogin) {
      // This fixture password is local to the isolated runner. Reauthentication
      // is solely to remove the test room after a deliberate Host logout case.
      const login = await context.request.post("/api/v1/auth/login", {
        headers: { origin },
        data: {
          username: "Host",
          password: "player-host-test-password-24-characters",
        },
      });
      expect(login.status()).toBe(200);
      current = (await login.json()) as FixtureSession;
    }
    expect(current).not.toBeNull();
    expect(current?.account.role).toBe("host");
    const response = await context.request.patch(`/api/v1/rooms/${roomId}`, {
      headers: { origin, "x-csrf-token": current!.csrfToken },
      data: { close: true },
    });
    if (
      response.status() === 401 &&
      attempt === 0 &&
      (await errorCode(response)) === "CSRF_INVALID"
    )
      continue;
    expect(response.status()).toBe(200);
    return;
  }
  throw new Error("Fixture room close exceeded the single CSRF recovery");
}
