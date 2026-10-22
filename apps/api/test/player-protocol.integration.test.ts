import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { v7 as uuidv7 } from "uuid";
import type { RawData, WebSocket } from "ws";
import {
  roomCommandAppliedSchema,
  playbackStatusSummarySchema,
  type RoomCommandRequest,
} from "@simplewatch/contracts";

import { buildApp, type BuiltApp } from "../src/app.js";

const origin = "https://player.example.test";
const password = "player-protocol-password-at-least-24";
let built: BuiltApp;
let testRoot: string;
let currentNow: number;
let roomId: string;
let hostToken: string;
let hostCsrf: string;
let viewerToken: string;
let viewerMemberId: string;
const sockets: WebSocket[] = [];

interface Message {
  readonly type: string;
  readonly payload: unknown;
  readonly replyTo?: string;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  currentNow = 1_780_000_000_000;
  mkdirSync(resolve("tmp"), { recursive: true });
  testRoot = mkdtempSync(join(resolve("tmp"), "player-protocol-"));
  built = await buildApp({
    databasePath: join(testRoot, "state.sqlite3"),
    migrationsPath: resolve("migrations"),
    publicOrigin: origin,
    mediaRoot: join(testRoot, "media"),
    uploadRoot: join(testRoot, "uploads"),
    inboxRoot: join(testRoot, "inbox"),
    subtitleRoot: join(testRoot, "subtitles"),
    trashRoot: join(testRoot, "trash"),
    now: () => currentNow,
    authFailureDelay: () => Promise.resolve(),
  });
  await built.authService.provisionAccounts([
    { username: "Host", role: "host", password },
    { username: "Simple", role: "viewer", password },
  ]);
  const host = await built.authService.login("Host", password, "127.0.0.1");
  hostToken = host.sessionToken;
  hostCsrf = host.csrfToken;
  roomId = built.roomService.createAccountRoom(
    built.authService.authenticate(hostToken),
  ).roomId;
  const viewer = await built.authService.login("Simple", password, "127.0.0.2");
  viewerToken = viewer.sessionToken;
  const entry = built.roomService.enterAccountRoom(
    built.authService.authenticate(viewerToken),
  );
  if (entry.state !== "room") throw new Error("Viewer did not enter test room");
  viewerMemberId = entry.memberId;
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await built.app.close();
  vi.useRealTimers();
  rmSync(testRoot, { recursive: true, force: true });
});

describe("player protocol additive compatibility and delivery", () => {
  it("returns legacy hello only to its sender and advertises capabilities in bootstrap", async () => {
    const host = await connect(hostToken);
    const viewer = await connect(viewerToken);
    const hostMessages: Message[] = [];
    host.on("message", (data) => hostMessages.push(decode(data)));
    const received = next(viewer, "room.snapshot");
    const helloId = send(viewer, "room.hello", {});
    const helloReply = await received;
    expect(helloReply.replyTo).toBe(helloId);
    expect(helloReply.payload).toMatchObject({
      revision: 0,
      capabilities: { commandAck: true, playbackStatus: true },
    });
    await barrier(host);
    expect(
      hostMessages.filter((message) => message.type === "room.snapshot"),
    ).toEqual([]);
    const bootstrap = await built.app.inject({
      method: "GET",
      url: `/api/v1/rooms/${roomId}/bootstrap`,
      headers: { cookie: cookie(viewerToken) },
    });
    expect(bootstrap.json()).toMatchObject({
      snapshot: { capabilities: { commandAck: true, playbackStatus: true } },
    });
  });

  it("does not reflect an invalid hello correlation id and leaves CSRF unchanged", async () => {
    const host = await connect(hostToken);
    const accountBefore = built.authService.authenticate(hostToken);
    const response = next(host, "room.snapshot");
    host.send(
      JSON.stringify({
        v: 1,
        type: "room.hello",
        id: "not-a-uuid",
        roomId,
        sentAtMs: currentNow,
        payload: {},
      }),
    );
    expect((await response).replyTo).toBeUndefined();
    expect(built.authService.authenticate(hostToken).csrf_hash).toBe(
      accountBefore.csrf_hash,
    );
    const fresh = next(host, "room.snapshot");
    const requestId = send(host, "room.hello", {});
    expect((await fresh).replyTo).toBe(requestId);
    expect(built.authService.authenticate(hostToken).csrf_hash).toBe(
      accountBefore.csrf_hash,
    );
  });

  it("acknowledges commands and replays the original receipt without broadcasting stale state", async () => {
    const host = await connect(hostToken);
    const viewer = await connect(viewerToken);
    const peerSnapshots: Message[] = [];
    viewer.on("message", (data) => {
      const message = decode(data);
      if (message.type === "room.snapshot") peerSnapshots.push(message);
    });
    const first = command(0, { kind: "select-live" });
    const ack1 = next(host, "room.command.applied");
    send(host, "room.command", first);
    const original = roomCommandAppliedSchema.parse((await ack1).payload);
    expect(original).toMatchObject({
      commandId: first.commandId,
      revision: 1,
      snapshot: {
        revision: 1,
        cause: { commandId: first.commandId, kind: "select-live" },
      },
      currentSnapshot: { revision: 1 },
    });
    const second = command(1, { kind: "select-live" });
    const ack2 = next(host, "room.command.applied");
    send(host, "room.command", second);
    expect((await ack2).payload).toMatchObject({ revision: 2 });
    await barrier(viewer);
    expect(peerSnapshots).toHaveLength(2);

    const retried = next(host, "room.command.applied");
    send(host, "room.command", first);
    const receipt = roomCommandAppliedSchema.parse((await retried).payload);
    expect(receipt.revision).toBe(1);
    expect(receipt.snapshot).toEqual(original.snapshot);
    expect(receipt.currentSnapshot.revision).toBe(2);
    await barrier(viewer);
    expect(peerSnapshots).toHaveLength(2);
    expect(built.roomService.getSnapshot(roomId).revision).toBe(2);
  });

  it("broadcasts authoritative seek causes and future anchors for playing and paused VOD", async () => {
    const mediaId = uuidv7();
    built.database
      .prepare(
        "INSERT INTO media(id,storage_key,display_name,state,duration_ms,created_at) VALUES (?,?,'fixture','published',120000,?)",
      )
      .run(mediaId, mediaId, currentNow);
    const host = await connect(hostToken);
    const viewer = await connect(viewerToken);
    const sequence: RoomCommandRequest["command"][] = [
      { kind: "select-vod", mediaId },
      { kind: "play" },
      { kind: "seek", positionSec: 50 },
      { kind: "pause" },
      { kind: "seek", positionSec: 10 },
    ];
    for (const [index, value] of sequence.entries()) {
      currentNow += 1000;
      const request = command(index, value);
      const ack = next(host, "room.command.applied");
      const delivered = next(viewer, "room.snapshot");
      send(host, "room.command", request);
      const receipt = roomCommandAppliedSchema.parse((await ack).payload);
      expect((await delivered).payload).toEqual(receipt.snapshot);
      expect(receipt.snapshot).toMatchObject({
        revision: index + 1,
        cause: { commandId: request.commandId, kind: value.kind },
        transport: { anchoredAtServerMs: currentNow + 750 },
      });
      if (value.kind === "seek") {
        expect(receipt.snapshot.transport).toMatchObject({
          positionSec: value.positionSec,
          state: index === 2 ? "playing" : "paused",
        });
      }
    }
  });

  it("returns an exact rejection with current snapshot and does not acknowledge a conflicting command", async () => {
    const host = await connect(hostToken);
    const accepted = next(host, "room.command.applied");
    send(host, "room.command", command(0, { kind: "select-live" }));
    await accepted;
    const stale = command(0, { kind: "select-live" });
    const rejected = next(host, "room.command.rejected");
    send(host, "room.command", stale);
    expect((await rejected).payload).toMatchObject({
      commandId: stale.commandId,
      code: "REVISION_CONFLICT",
      details: { snapshot: { revision: 1 } },
    });
    expect(built.roomService.getSnapshot(roomId).revision).toBe(1);
  });

  it("keeps viewer control forbidden and revalidates a disabled account on the existing connection", async () => {
    const viewer = await connect(viewerToken);
    const denied = next(viewer, "room.command.rejected");
    send(viewer, "room.command", command(0, { kind: "select-live" }));
    expect((await denied).payload).toMatchObject({ code: "FORBIDDEN" });
    built.database
      .prepare("UPDATE accounts SET enabled = 0 WHERE username = 'Simple'")
      .run();
    const closed = onClose(viewer);
    send(viewer, "room.hello", {});
    expect(await closed).toMatchObject({
      code: 4001,
      reason: "session invalid",
    });
    expect(built.roomService.getSnapshot(roomId).revision).toBe(0);
  });

  it("uses recoverable heartbeat timeout but retains removed and closed codes", async () => {
    const idle = await connect(viewerToken);
    const timeout = onClose(idle);
    currentNow += 60_001;
    vi.advanceTimersByTime(20_000);
    expect(await timeout).toMatchObject({
      code: 4000,
      reason: "heartbeat timeout",
    });

    const viewer = await connect(viewerToken);
    const removed = onClose(viewer);
    const kick = await built.app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/members/${viewerMemberId}/kick`,
      headers: { cookie: cookie(hostToken), origin, "x-csrf-token": hostCsrf },
      payload: {},
    });
    expect(kick.statusCode).toBe(200);
    expect(await removed).toMatchObject({ code: 4003 });

    const host = await connect(hostToken);
    const closed = onClose(host);
    const close = await built.app.inject({
      method: "PATCH",
      url: `/api/v1/rooms/${roomId}`,
      headers: { cookie: cookie(hostToken), origin, "x-csrf-token": hostCsrf },
      payload: { close: true },
    });
    expect(close.statusCode).toBe(200);
    expect(await closed).toMatchObject({ code: 4010 });
  });
});

describe("bounded host-only playback observations", () => {
  it("derives identity, preserves null fields and expires reports after thirty seconds without changing room state", async () => {
    const host = await connect(hostToken);
    const viewer = await connect(viewerToken);
    const viewerMessages: Message[] = [];
    viewer.on("message", (data) => viewerMessages.push(decode(data)));
    const summary = next(host, "playback.status.summary");
    send(viewer, "playback.status", status());
    expect(playbackStatusSummarySchema.parse((await summary).payload)).toEqual({
      reports: [
        {
          memberId: viewerMemberId,
          nickname: "Simple",
          receivedAtMs: currentNow,
          report: status(),
        },
      ],
      serverNowMs: currentNow,
    });
    send(viewer, "room.hello", { playbackStatus: true });
    await barrier(viewer);
    expect(
      viewerMessages.some(
        (message) => message.type === "playback.status.summary",
      ),
    ).toBe(false);
    const expired = next(host, "playback.status.summary");
    currentNow += 30_000;
    vi.advanceTimersByTime(2000);
    expect((await expired).payload).toMatchObject({ reports: [] });
    expect(built.roomService.getSnapshot(roomId).revision).toBe(0);
    expect(
      built.database
        .prepare("SELECT COUNT(*) AS count FROM room_commands")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      built.database
        .prepare("SELECT COUNT(*) AS count FROM program_watch_ranges")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("limits each seat across connections and bounds message size while rejecting identity and path injection", async () => {
    const host = await connect(hostToken);
    const viewer = await connect(viewerToken);
    const first = next(host, "playback.status.summary");
    send(viewer, "playback.status", status());
    await first;
    const another = await connect(viewerToken);
    const limited = next(another, "playback.status.rejected");
    send(another, "playback.status", status());
    expect((await limited).payload).toMatchObject({
      code: "PLAYBACK_STATUS_RATE_LIMITED",
    });
    currentNow += 1000;
    const invalid = next(viewer, "playback.status.rejected");
    send(viewer, "playback.status", {
      ...status(),
      memberId: uuidv7(),
      path: "/private/movie",
    });
    expect((await invalid).payload).toMatchObject({
      code: "INVALID_PLAYBACK_STATUS",
    });
    const oversized = next(viewer, "playback.status.rejected");
    send(viewer, "playback.status", { ...status(), padding: "x".repeat(4096) });
    expect((await oversized).payload).toMatchObject({
      code: "PLAYBACK_STATUS_TOO_LARGE",
    });
    const accepted = next(host, "playback.status.summary");
    send(viewer, "playback.status", { ...status(), state: "paused" });
    expect((await accepted).payload).toMatchObject({
      reports: [{ report: { state: "paused" } }],
    });
  });

  it("rejects a displaced device on its existing socket and permits the current seat to report", async () => {
    const host = await connect(hostToken);
    const previous = await connect(viewerToken);
    const login = await built.authService.login(
      "Simple",
      password,
      "127.0.0.3",
    );
    built.roomService.takeoverAccountRoom(
      built.authService.authenticate(login.sessionToken),
    );
    const displaced = onClose(previous);
    send(previous, "playback.status", status());
    expect(await displaced).toMatchObject({ code: 4001 });
    const active = await connect(login.sessionToken);
    const summary = next(host, "playback.status.summary");
    send(active, "playback.status", status());
    expect((await summary).payload).toMatchObject({
      reports: [{ memberId: viewerMemberId, nickname: "Simple" }],
    });
  });

  it("revalidates the receiving Host before diagnostic delivery and drops revoked reporting seats", async () => {
    const host = await connect(hostToken);
    const viewer = await connect(viewerToken);
    const first = next(host, "playback.status.summary");
    send(viewer, "playback.status", status());
    await first;
    built.database
      .prepare("UPDATE accounts SET enabled = 0 WHERE username = 'Simple'")
      .run();
    const pruned = next(host, "playback.status.summary");
    vi.advanceTimersByTime(2000);
    expect((await pruned).payload).toMatchObject({ reports: [] });

    built.database
      .prepare("UPDATE accounts SET enabled = 1 WHERE username = 'Simple'")
      .run();
    const resumed = await connect(viewerToken);
    built.database
      .prepare("UPDATE accounts SET enabled = 0 WHERE username = 'Host'")
      .run();
    const messages: Message[] = [];
    host.on("message", (data) => messages.push(decode(data)));
    const revoked = onClose(host);
    currentNow += 1000;
    send(resumed, "playback.status", status());
    expect(await revoked).toMatchObject({ code: 4001 });
    expect(
      messages.some((message) => message.type === "playback.status.summary"),
    ).toBe(false);
  });
});

async function connect(token: string): Promise<WebSocket> {
  const socket = await built.app.injectWS(`/api/v1/rooms/${roomId}/ws`, {
    headers: {
      cookie: cookie(token),
      origin,
      "sec-websocket-protocol": "simplewatch.v1",
    },
  });
  sockets.push(socket);
  return socket;
}

function cookie(token: string): string {
  return `__Host-sw_session=${token}`;
}

function status() {
  return {
    mode: "vod",
    mediaId: null,
    state: "playing",
    positionSec: 12.5,
    targetSec: null,
    revision: 0,
    readyState: 4,
    videoFrames: null,
    fps: null,
  };
}

function command(
  revision: number,
  value: RoomCommandRequest["command"],
): RoomCommandRequest {
  return {
    commandId: uuidv7(),
    expectedRevision: revision,
    effectiveAtServerMs: currentNow + 750,
    command: value,
  };
}

function send(socket: WebSocket, type: string, payload: unknown): string {
  const id = uuidv7();
  socket.send(
    JSON.stringify({
      v: 1,
      type,
      id,
      roomId,
      sentAtMs: currentNow,
      payload,
    }),
  );
  return id;
}

function decode(data: RawData): Message {
  const buffer = Array.isArray(data)
    ? Buffer.concat(data)
    : data instanceof ArrayBuffer
      ? Buffer.from(data)
      : data;
  return JSON.parse(buffer.toString("utf8")) as Message;
}

function next(socket: WebSocket, type: string): Promise<Message> {
  return new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", receive);
      reject(new Error(`Missing ${type}`));
    }, 3000);
    const receive = (data: RawData) => {
      const message = decode(data);
      if (message.type !== type) return;
      clearTimeout(timer);
      socket.off("message", receive);
      resolveMessage(message);
    };
    socket.on("message", receive);
  });
}

async function barrier(socket: WebSocket): Promise<void> {
  const pong = next(socket, "clock.pong");
  send(socket, "clock.ping", { clientSentAtMs: currentNow });
  await pong;
}

function onClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolveClose) => {
    socket.once("close", (code: number, reason: Buffer) =>
      resolveClose({ code, reason: reason.toString() }),
    );
  });
}
