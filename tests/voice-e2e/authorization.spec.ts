import { randomUUID } from "node:crypto";

import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { RoomServiceClient } from "livekit-server-sdk";

import { processOutboxItem } from "../../apps/worker/src/process-outbox.js";
import {
  closeFixtureRoom,
  logoutFixtureSession,
  stopFixturePageActivity,
} from "./cleanup.js";

// These are isolated runner fixtures, never production endpoints or credentials.
const origin = "https://127.0.0.1:18443";
const hostPassword = "player-host-test-password-24-characters";
const viewerPassword = "player-viewer-test-password-24-characters";
const rtc = new RoomServiceClient(
  "http://127.0.0.1:17880",
  "local-voice-gate-key",
  "local-voice-gate-secret-not-production-32-bytes",
);

interface Client {
  context: BrowserContext;
  page: Page;
}
interface Session {
  csrfToken: string;
  account: { role: "host" | "viewer" };
  destination: { state: string };
}
interface Participant {
  identity: string;
  sid: string;
  name: string;
}

async function client(browser: Browser): Promise<Client> {
  const context = await browser.newContext({
    baseURL: origin,
    ignoreHTTPSErrors: true,
  });
  return { context, page: await context.newPage() };
}

async function login(page: Page, username: string) {
  await page.goto("/");
  await page.getByLabel("账户名称").fill(username);
  await page
    .getByLabel("账户密码")
    .fill(username === "Host" ? hostPassword : viewerPassword);
  await page.getByRole("button", { name: /凭证入场/ }).click();
}

async function voiceJoined(page: Page) {
  await expect(
    page
      .locator(".voice-panel__desktop")
      .getByText("已加入语音频道", { exact: true }),
  ).toBeVisible();
}

async function createRoom(host: Client): Promise<string> {
  await login(host.page, "Host");
  await expect(
    host.page.getByRole("heading", { name: "放映控制", exact: true }),
  ).toBeVisible();
  const create = host.page.getByRole("button", { name: /开启放映室/ });
  const close = host.page.getByRole("button", { name: "强制关闭房间" });
  await expect(create.or(close)).toBeVisible();
  if (await close.isVisible()) {
    host.page.once("dialog", (dialog) => dialog.accept());
    await close.click();
    await expect(create).toBeVisible();
  }
  await create.click();
  await host.page.getByRole("button", { name: "进入主持房间" }).click();
  await expect(host.page).toHaveURL(/\/room\//);
  await voiceJoined(host.page);
  const roomId = new URL(host.page.url()).pathname.split("/").at(-1);
  if (!roomId) throw new Error("Isolated voice test room was not created");
  return roomId;
}

async function participants(roomId: string): Promise<Participant[]> {
  try {
    return await rtc.listParticipants(`voice:${roomId}`);
  } catch (error) {
    // LiveKit may delete an empty room between the last departure and this read.
    if (
      error instanceof Error &&
      /room.+(?:does not exist|not found)|not found/i.test(error.message)
    )
      return [];
    throw error;
  }
}

async function participant(roomId: string, name: string) {
  await expect
    .poll(
      async () =>
        (await participants(roomId)).filter((entry) => entry.name === name)
          .length,
    )
    .toBe(1);
  const value = (await participants(roomId)).find(
    (entry) => entry.name === name,
  );
  if (!value) throw new Error(`Missing isolated RTC participant: ${name}`);
  expect(value.identity).toMatch(/^v2:[0-9a-f-]{36}:[0-9a-f-]{36}:[1-9]\d+$/);
  return value;
}

function lease(identity: string) {
  const [, memberId, deviceId, epoch] = identity.split(":");
  if (!memberId || !deviceId || !epoch)
    throw new Error("Expected a complete v2 RTC identity");
  return { memberId, deviceId, epoch: Number(epoch) };
}

async function sameConnection(roomId: string, value: Participant) {
  await expect
    .poll(
      async () =>
        (await participants(roomId)).find(
          (entry) => entry.identity === value.identity,
        )?.sid,
    )
    .toBe(value.sid);
}

async function cannotIssueVoice(context: BrowserContext, roomId: string) {
  const sessionResponse = await context.request.get("/api/v1/auth/session");
  const session = sessionResponse.ok()
    ? ((await sessionResponse.json()) as Session)
    : null;
  const result = await context.request.post(
    `/api/v1/rooms/${roomId}/credentials`,
    {
      headers: {
        origin,
        ...(session ? { "x-csrf-token": session.csrfToken } : {}),
      },
      data: { purpose: "voice" },
    },
  );
  expect(result.status()).toBe(401);
  expect(
    ((await result.json()) as { error: { code: string } }).error.code,
  ).toBe("UNAUTHORIZED");
}

async function closeRoom(host: Client) {
  host.page.once("dialog", (dialog) => dialog.accept());
  await host.page
    .getByRole("button", { name: "关闭房间", exact: true })
    .click();
  await expect(host.page).toHaveURL(/\/admin$/);
}

async function cleanup(
  clients: Client[],
  host: Client,
  roomId: string | undefined,
) {
  const failures: unknown[] = [];
  try {
    await stopFixturePageActivity(clients.map((current) => current.context));
    if (roomId) {
      await closeFixtureRoom(host.context, roomId, true);
      await expect
        .poll(async () => (await participants(roomId)).length)
        .toBe(0);
    }
  } catch (error) {
    failures.push(error);
  }
  // Context.close alone leaves account sessions and waiting queue entries alive.
  for (const current of [...clients].reverse()) {
    try {
      await logoutFixtureSession(current.context);
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        await current.context.close();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "Voice gate cleanup failed");
}

test("A-B-A device handoff removes old SFU identities and delayed or legacy outbox cannot remove the new lease", async ({
  browser,
}) => {
  const clients: Client[] = [];
  const host = await client(browser);
  clients.push(host);
  let roomId: string | undefined;
  try {
    roomId = await createRoom(host);
    const hostParticipant = await participant(roomId, "Host");
    const a = await client(browser);
    clients.push(a);
    await login(a.page, "Simple");
    await voiceJoined(a.page);
    const firstA = await participant(roomId, "Simple");

    const b = await client(browser);
    clients.push(b);
    await login(b.page, "Simple");
    await voiceJoined(b.page);
    const firstB = await participant(roomId, "Simple");
    expect(firstB.identity).not.toBe(firstA.identity);
    expect(lease(firstB.identity).memberId).toBe(
      lease(firstA.identity).memberId,
    );
    expect(lease(firstB.identity).deviceId).not.toBe(
      lease(firstA.identity).deviceId,
    );
    expect(lease(firstB.identity).epoch).toBeGreaterThan(
      lease(firstA.identity).epoch,
    );
    await cannotIssueVoice(a.context, roomId);

    await a.page.goto("/");
    await a.page
      .getByRole("button", { name: "在本设备接管席位", exact: true })
      .click();
    await voiceJoined(a.page);
    const finalA = await participant(roomId, "Simple");
    expect(lease(finalA.identity).memberId).toBe(
      lease(firstA.identity).memberId,
    );
    expect(lease(finalA.identity).deviceId).toBe(
      lease(firstA.identity).deviceId,
    );
    expect(lease(finalA.identity).epoch).toBeGreaterThan(
      lease(firstB.identity).epoch,
    );
    expect(finalA.identity).not.toBe(firstA.identity);
    await cannotIssueVoice(b.context, roomId);

    // Replay genuinely late work through the production processor and real SFU
    // admin API. No mock maps a historical memberId onto the current identity.
    for (const rtcIdentity of [firstA.identity, firstB.identity, undefined]) {
      await processOutboxItem(
        {
          id: randomUUID(),
          kind: "rtc.remove-participant",
          leaseToken: "isolated-replay-only",
          payload: {
            roomId,
            memberId: lease(firstA.identity).memberId,
            ...(rtcIdentity ? { rtcIdentity } : {}),
          },
        },
        { livekit: rtc, mediamtxControlUrl: "http://127.0.0.1:19997" },
      );
      await sameConnection(roomId, finalA);
      await sameConnection(roomId, hostParticipant);
    }
    expect(
      (await participants(roomId)).map((entry) => entry.identity).sort(),
    ).toEqual([hostParticipant.identity, finalA.identity].sort());
    await closeRoom(host);
    await expect.poll(async () => (await participants(roomId!)).length).toBe(0);
  } finally {
    await cleanup(clients, host, roomId);
  }
});

test("Host kick revokes the exact RTC member, preserves other seats, and room close removes every participant", async ({
  browser,
}) => {
  const clients: Client[] = [];
  const host = await client(browser);
  clients.push(host);
  let roomId: string | undefined;
  try {
    roomId = await createRoom(host);
    const hostParticipant = await participant(roomId, "Host");
    const removed = await client(browser);
    clients.push(removed);
    await login(removed.page, "Simple");
    await voiceJoined(removed.page);
    const removedParticipant = await participant(roomId, "Simple");
    await removed.page
      .getByRole("button", { name: "打开麦克风", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await rtc.listParticipants(`voice:${roomId}`)).find(
            (entry) => entry.identity === removedParticipant.identity,
          )?.tracks.length,
      )
      .toBe(1);
    const remaining = await client(browser);
    clients.push(remaining);
    await login(remaining.page, "FJ233");
    await voiceJoined(remaining.page);
    const remainingParticipant = await participant(roomId, "FJ233");

    host.page.once("dialog", (dialog) => dialog.accept());
    const kick = host.page
      .locator(".seat-list li")
      .filter({ hasText: "Simple" })
      .getByRole("button", { name: "移出", exact: true });
    await expect(kick).toBeVisible();
    await kick.click();
    await expect
      .poll(async () =>
        (await participants(roomId!)).some(
          (entry) => entry.identity === removedParticipant.identity,
        ),
      )
      .toBe(false);
    await cannotIssueVoice(removed.context, roomId);
    await sameConnection(roomId, hostParticipant);
    await sameConnection(roomId, remainingParticipant);

    await closeRoom(host);
    await expect.poll(async () => (await participants(roomId!)).length).toBe(0);
    await cannotIssueVoice(remaining.context, roomId);
    await cannotIssueVoice(host.context, roomId);
  } finally {
    await cleanup(clients, host, roomId);
  }
});

test("Host account logout revokes its real SFU connection without requiring cooperative UI teardown", async ({
  browser,
}) => {
  const clients: Client[] = [];
  const host = await client(browser);
  clients.push(host);
  let roomId: string | undefined;
  try {
    roomId = await createRoom(host);
    const hostParticipant = await participant(roomId, "Host");
    const viewer = await client(browser);
    clients.push(viewer);
    await login(viewer.page, "Simple");
    await voiceJoined(viewer.page);
    const viewerParticipant = await participant(roomId, "Simple");

    // Intentionally leave the room page mounted. Revocation must not depend on
    // the browser calling voice.disconnect before its account session ends.
    const sessionResponse = await host.context.request.get(
      "/api/v1/auth/session",
    );
    expect(sessionResponse.status()).toBe(200);
    const session = (await sessionResponse.json()) as Session;
    const response = await host.context.request.post("/api/v1/auth/logout", {
      headers: { origin, "x-csrf-token": session.csrfToken },
    });
    expect(response.status()).toBe(204);
    await expect
      .poll(async () =>
        (await participants(roomId!)).some(
          (entry) => entry.identity === hostParticipant.identity,
        ),
      )
      .toBe(false);
    await cannotIssueVoice(host.context, roomId);
    await sameConnection(roomId, viewerParticipant);
  } finally {
    await cleanup(clients, host, roomId);
  }
});
