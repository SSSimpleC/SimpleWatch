import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { v7 as uuidv7 } from "uuid";
import { z } from "zod";

import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import websocket from "@fastify/websocket";
import {
  accountRoomEntrySchema,
  authLoginRequestSchema,
  envelopeSchema,
  kickMemberRequestSchema,
  playbackProgressSchema,
  playbackStatusSchema,
  activeRoomSummarySchema,
  roomCommandRequestSchema,
  roomSnapshotSchema,
  updateRoomRequestSchema,
} from "@simplewatch/contracts";
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { RawData, WebSocket } from "ws";

import { openDatabase, type AppDatabase } from "./database.js";
import { AdminEventHub } from "./admin-event-hub.js";
import { registerEdgeAdminRoutes } from "./edge-admin-routes.js";
import { AppError, forbidden } from "./errors.js";
import { registerEdgeAgentRoutes } from "./edge-agent-routes.js";
import { registerEdgeInternalRoutes } from "./edge-internal-routes.js";
import { registerMediaRoutes } from "./media-routes.js";
import { registerOutboxRoutes } from "./outbox-routes.js";
import { PublicRateLimiter } from "./public-rate-limiter.js";
import { RoomHub } from "./room-hub.js";
import { AuthService } from "./services/auth-service.js";
import { EdgeAuthService } from "./services/edge-auth-service.js";
import { EdgeAdminService } from "./services/edge-admin-service.js";
import { EdgeCatalogService } from "./services/edge-catalog-service.js";
import { EdgeTaskService } from "./services/edge-task-service.js";
import { EdgeTransferLifecycleService } from "./services/edge-transfer-lifecycle-service.js";
import { EdgeEvictionService } from "./services/edge-eviction-service.js";
import { MediaService } from "./services/media-service.js";
import { OutboxService } from "./services/outbox-service.js";
import { ProgramService } from "./services/program-service.js";
import {
  RoomService,
  type AccountRoomEntry,
  type RoomIdentity,
} from "./services/room-service.js";
import { TransportService } from "./services/transport-service.js";
import { registerTransportRoutes } from "./transport-routes.js";

const roomParamsSchema = z.object({ roomId: z.string().uuid() });
const emptyResponseSchema = z.null();
const authSessionResponseSchema = z.object({
  account: z.object({
    id: z.string().uuid(),
    username: z.string(),
    role: z.enum(["host", "viewer"]),
  }),
  csrfToken: z.string(),
  idleExpiresAt: z.iso.datetime(),
  absoluteExpiresAt: z.iso.datetime(),
  destination: accountRoomEntrySchema,
});
const roomSessionResponseSchema = z.object({
  room: z.object({ id: z.string().uuid(), joinUrl: z.url().optional() }),
  member: z.object({
    id: z.string().uuid(),
    nickname: z.string(),
    role: z.enum(["host", "member"]),
  }),
  csrfToken: z.string(),
  expiresAt: z.iso.datetime(),
});
const clockPingEnvelopeSchema = envelopeSchema(
  z.object({ clientSentAtMs: z.number().int().nonnegative() }),
);
const commandEnvelopeSchema = envelopeSchema(roomCommandRequestSchema);
const playbackProgressEnvelopeSchema = envelopeSchema(playbackProgressSchema);
const playbackStatusEnvelopeSchema = envelopeSchema(playbackStatusSchema);

export interface BuildAppOptions {
  readonly databasePath: string;
  readonly publicOrigin: string;
  readonly mediaRoot?: string;
  readonly uploadRoot?: string;
  readonly inboxRoot?: string;
  readonly subtitleRoot?: string;
  readonly trashRoot?: string;
  readonly tusEndpoint?: string;
  readonly contentSigningSecret?: string;
  readonly internalHookToken?: string;
  readonly mediaJwtSecret?: string;
  readonly obsCredentialEncryptionKey?: string;
  readonly mediaOrigin?: string;
  readonly livekitApiKey?: string;
  readonly livekitApiSecret?: string;
  readonly livekitUrl?: string;
  readonly mediamtxControlUrl?: string;
  readonly webRoot?: string;
  readonly migrationsPath?: string;
  readonly now?: () => number;
  readonly logger?: boolean;
  readonly authFailureDelay?: (milliseconds: number) => Promise<void>;
  readonly passwordPepper?: string;
}

export interface BuiltApp {
  readonly app: FastifyInstance;
  readonly database: AppDatabase;
  readonly authService: AuthService;
  readonly roomService: RoomService;
  readonly mediaService: MediaService;
  readonly transportService: TransportService;
  readonly outboxService: OutboxService;
  readonly edgeAuthService: EdgeAuthService;
  readonly edgeCatalogService: EdgeCatalogService;
  readonly edgeTaskService: EdgeTaskService;
  readonly programService: ProgramService;
  readonly edgeAdminService: EdgeAdminService;
  readonly edgeEvictionService: EdgeEvictionService;
}

export async function buildApp(options: BuildAppOptions): Promise<BuiltApp> {
  const now = options.now ?? Date.now;
  const database = openDatabase({
    databasePath: options.databasePath,
    ...(options.migrationsPath
      ? { migrationsPath: options.migrationsPath }
      : {}),
    now,
  });
  const authService = new AuthService(
    database,
    now,
    options.passwordPepper ?? "test-password-pepper-not-for-production",
    options.authFailureDelay,
  );
  const edgeLifecycle = new EdgeTransferLifecycleService(
    database,
    options.uploadRoot ?? "tmp/uploads",
  );
  const edgeAuthService = new EdgeAuthService(database, now, edgeLifecycle);
  const edgeCatalogService = new EdgeCatalogService(database, now);
  const edgeTaskService = new EdgeTaskService(database, now, edgeLifecycle);
  const programService = new ProgramService(database, edgeTaskService, now);
  const roomService = new RoomService(database, programService, now);
  const mediaService = new MediaService(database, {
    mediaRoot: options.mediaRoot ?? "tmp/media",
    uploadRoot: options.uploadRoot ?? "tmp/uploads",
    inboxRoot: options.inboxRoot ?? "tmp/inbox",
    subtitleRoot: options.subtitleRoot ?? "tmp/subtitles",
    trashRoot: options.trashRoot ?? "tmp/trash",
    tusEndpoint: options.tusEndpoint ?? `${options.publicOrigin}/files/`,
    contentSigningSecret:
      options.contentSigningSecret ?? "test-content-signing-secret-32-bytes",
    now,
  });
  const edgeEvictionService = new EdgeEvictionService(
    database,
    edgeTaskService,
    options.mediaRoot ?? "tmp/media",
    options.trashRoot ?? "tmp/trash",
    now,
  );
  const hub = new RoomHub(now);
  const adminEvents = new AdminEventHub(now);
  const edgeAdminService = new EdgeAdminService(
    database,
    options.uploadRoot ?? "tmp/uploads",
    now,
  );
  const outboxService = new OutboxService(database, now);
  const transportService = new TransportService(database, {
    mediaJwtSecret:
      options.mediaJwtSecret ?? "test-media-jwt-secret-at-least-32-bytes",
    obsCredentialEncryptionKey:
      options.obsCredentialEncryptionKey ??
      "test-obs-credential-encryption-key-at-least-32-bytes",
    mediaOrigin: options.mediaOrigin ?? options.publicOrigin,
    livekitApiKey: options.livekitApiKey ?? "test-api-key",
    livekitApiSecret:
      options.livekitApiSecret ?? "test-livekit-secret-at-least-32-bytes",
    livekitUrl: options.livekitUrl ?? "ws://127.0.0.1:7880",
    mediamtxControlUrl: options.mediamtxControlUrl ?? "http://127.0.0.1:9997",
    now,
  });
  const app = Fastify({
    logger: options.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: false,
    requestIdHeader: false,
  });
  const publicRateLimiter = new PublicRateLimiter(now);

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addContentTypeParser(
    "application/webhook+json",
    { parseAs: "string" },
    (_request, body, done) => done(null, body),
  );
  await app.register(cookie);
  await app.register(swagger, {
    openapi: {
      info: { title: "SimpleWatch API", version: "0.1.0" },
      servers: [{ url: options.publicOrigin }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(websocket, {
    options: { maxPayload: 64 * 1024 },
  });

  app.addHook("onRequest", (request, _reply, done) => {
    if (
      ["POST", "PATCH", "PUT", "DELETE"].includes(request.method) &&
      request.url.startsWith("/api/v1/") &&
      !request.url.startsWith("/api/v1/internal/") &&
      !request.url.startsWith("/api/v1/edge/v1/") &&
      request.headers.origin !== options.publicOrigin
    ) {
      done(forbidden("Origin 不受信任"));
      return;
    }
    const path = request.url.split("?", 1)[0] ?? request.url;
    const isCredentialRequest =
      ["GET", "POST"].includes(request.method) &&
      (/^\/api\/v1\/rooms\/[^/]+\/credentials$/.test(path) ||
        /^\/api\/v1\/rooms\/[^/]+\/live\/publish-config$/.test(path));
    const roomSession = getAccountCookie(request);
    const credentialKey = roomSession
      ? createHash("sha256").update(roomSession).digest("hex")
      : request.ip;
    if (
      isCredentialRequest &&
      !publicRateLimiter.isAllowed(`credential:${credentialKey}`, 20)
    ) {
      done(new AppError(429, "RATE_LIMITED", "请求过于频繁，请稍后重试"));
      return;
    }
    if (isCredentialRequest)
      publicRateLimiter.record(`credential:${credentialKey}`, 60_000);
    done();
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return sendError(
        reply,
        request,
        error.statusCode,
        error.code,
        error.message,
        error.details,
      );
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      return sendError(
        reply,
        request,
        400,
        "VALIDATION_ERROR",
        "请求参数无效",
        error.validation,
      );
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      return sendError(
        reply,
        request,
        error.statusCode,
        "BAD_REQUEST",
        "请求无法处理",
      );
    }
    request.log.error(error);
    return sendError(reply, request, 500, "INTERNAL_ERROR", "服务器内部错误");
  });

  registerHealthRoutes(app, database, mediaService);
  registerEdgeAgentRoutes(
    app,
    edgeAuthService,
    edgeCatalogService,
    edgeTaskService,
    mediaService,
    adminEvents,
  );
  registerEdgeAdminRoutes(
    app,
    authService,
    edgeAdminService,
    edgeCatalogService,
    edgeTaskService,
    programService,
    edgeEvictionService,
    adminEvents,
  );
  registerEdgeInternalRoutes(
    app,
    programService,
    edgeEvictionService,
    edgeCatalogService,
    adminEvents,
    options.internalHookToken ?? "test-internal-service-token-32-bytes",
  );
  registerUnifiedApiRoutes(
    app,
    authService,
    roomService,
    transportService,
    hub,
    options.publicOrigin,
    now,
  );
  registerMediaRoutes(
    app,
    authService,
    roomService,
    mediaService,
    options.internalHookToken ?? "test-internal-service-token-32-bytes",
  );
  registerTransportRoutes(app, roomService, transportService, outboxService);
  registerOutboxRoutes(
    app,
    outboxService,
    options.internalHookToken ?? "test-internal-service-token-32-bytes",
  );
  registerWebSocketRoute(
    app,
    roomService,
    programService,
    hub,
    options.publicOrigin,
    now,
  );

  const webRoot = resolve(options.webRoot ?? "dist/web");
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, {
      root: webRoot,
      wildcard: false,
      setHeaders(response, path) {
        if (
          /(?:^|[/\\])(?:index\.html|sw\.js|player-version\.json)$/.test(path)
        )
          response.header("Cache-Control", "no-store");
      },
    });
    app.get("/*", (request, reply) => {
      if (
        request.url.startsWith("/api/") ||
        request.url.startsWith("/media-files/")
      ) {
        throw new AppError(404, "NOT_FOUND", "资源不存在");
      }
      reply.header("Cache-Control", "no-store");
      return reply.sendFile("index.html", { maxAge: 0, immutable: false });
    });
  }

  app.addHook("onClose", (_instance, done) => {
    hub.dispose();
    if (database.open) database.close();
    done();
  });
  await app.ready();
  return {
    app,
    database,
    authService,
    roomService,
    mediaService,
    transportService,
    outboxService,
    edgeAuthService,
    edgeCatalogService,
    edgeTaskService,
    programService,
    edgeAdminService,
    edgeEvictionService,
  };
}

function registerHealthRoutes(
  app: FastifyInstance,
  database: AppDatabase,
  mediaService: MediaService,
): void {
  const workerSchema = z.object({
    health: z.enum(["healthy", "stale", "missing"]),
    workerId: z.string().nullable(),
    status: z.enum(["idle", "busy", "degraded"]).nullable(),
    currentJobId: z.string().uuid().nullable(),
    lastSeenAt: z.iso.datetime().nullable(),
    ageMs: z.number().int().nonnegative().nullable(),
  });
  app.get(
    "/health/live",
    { schema: { response: { 200: z.object({ status: z.literal("ok") }) } } },
    () => ({ status: "ok" as const }),
  );
  app.get(
    "/health/ready",
    {
      schema: {
        response: {
          200: z.object({
            status: z.literal("ready"),
            database: z.literal("ok"),
            worker: workerSchema,
          }),
          503: z.object({
            status: z.literal("not-ready"),
            database: z.literal("ok"),
            worker: workerSchema,
          }),
        },
      },
    },
    (_request, reply) => {
      database.prepare("SELECT 1").get();
      const health = mediaService.getWorkerHealth();
      const worker = {
        health: health.health,
        workerId: health.workerId,
        status: health.status,
        currentJobId: health.currentJobId,
        lastSeenAt: health.lastSeenAt,
        ageMs: health.ageMs,
      };
      if (!health.healthy) {
        return reply.status(503).send({
          status: "not-ready" as const,
          database: "ok" as const,
          worker,
        });
      }
      return reply.send({
        status: "ready" as const,
        database: "ok" as const,
        worker,
      });
    },
  );
}

function registerUnifiedApiRoutes(
  baseApp: FastifyInstance,
  authService: AuthService,
  roomService: RoomService,
  transportService: TransportService,
  hub: RoomHub,
  publicOrigin: string,
  now: () => number,
): void {
  const app = baseApp.withTypeProvider<ZodTypeProvider>();

  const destinationFor = (
    session: ReturnType<AuthService["authenticate"]>,
    forceTakeover = false,
  ) => {
    if (session.role === "host") return { state: "admin" as const };
    const entry = forceTakeover
      ? roomService.takeoverAccountRoom(session)
      : roomService.getAccountRoomState(session);
    return toPublicEntry(entry);
  };

  app.post(
    "/api/v1/auth/login",
    {
      schema: {
        body: authLoginRequestSchema,
        response: { 200: authSessionResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await authService.login(
        request.body.username,
        request.body.password,
        request.ip,
      );
      const session = authService.authenticate(result.sessionToken);
      setAccountCookie(reply, result.sessionToken, result.absoluteExpiresAt);
      reply.header("Cache-Control", "no-store");
      return {
        account: result.account,
        csrfToken: result.csrfToken,
        idleExpiresAt: new Date(result.idleExpiresAt).toISOString(),
        absoluteExpiresAt: new Date(result.absoluteExpiresAt).toISOString(),
        destination: destinationFor(session, true),
      };
    },
  );

  app.get(
    "/api/v1/auth/session",
    { schema: { response: { 200: authSessionResponseSchema } } },
    (request, reply) => {
      const resumed = authService.resume(getAccountCookie(request));
      if (resumed.sessionToken) {
        setAccountCookie(
          reply,
          resumed.sessionToken,
          resumed.session.absolute_expires_at,
        );
      }
      reply.header("Cache-Control", "no-store");
      return {
        account: {
          id: resumed.session.account_id,
          username: resumed.session.username,
          role: resumed.session.role,
        },
        csrfToken: resumed.csrfToken,
        idleExpiresAt: new Date(resumed.session.idle_expires_at).toISOString(),
        absoluteExpiresAt: new Date(
          resumed.session.absolute_expires_at,
        ).toISOString(),
        destination: destinationFor(resumed.session),
      };
    },
  );

  app.post(
    "/api/v1/auth/logout",
    { schema: { response: { 204: emptyResponseSchema } } },
    (request, reply) => {
      const token = getAccountCookie(request);
      const session = authService.authenticate(token);
      authService.requireCsrf(session, getHeader(request, "x-csrf-token"));
      roomService.releaseAccountSession(session);
      if (token) authService.logout(token);
      reply.clearCookie("__Host-sw_session", {
        secure: true,
        httpOnly: true,
        sameSite: "strict",
        path: "/",
      });
      reply.header("Clear-Site-Data", '"cache", "cookies", "storage"');
      reply.status(204);
      return null;
    },
  );

  app.post(
    "/api/v1/room/enter",
    { schema: { response: { 200: accountRoomEntrySchema } } },
    (request) => {
      const session = authService.authenticate(getAccountCookie(request));
      if (session.role === "host") return { state: "admin" as const };
      const entry = roomService.enterAccountRoom(session, {
        forceTakeover: true,
      });
      if (entry.state === "room" && entry.tookOverSessionHash) {
        hub.closeMember(entry.roomId, entry.memberId, 4001, "seat taken over");
      }
      return toPublicEntry(entry);
    },
  );

  app.post(
    "/api/v1/room/takeover",
    { schema: { response: { 200: accountRoomEntrySchema } } },
    (request) => {
      const session = authService.authenticate(getAccountCookie(request));
      const entry = roomService.takeoverAccountRoom(session);
      if (entry.state === "room" && entry.tookOverSessionHash) {
        hub.closeMember(entry.roomId, entry.memberId, 4001, "seat taken over");
      }
      return toPublicEntry(entry);
    },
  );

  app.get("/api/v1/lobby/events", (request, reply) => {
    const token = getAccountCookie(request);
    const session = authService.authenticate(token);
    if (session.role === "host") throw forbidden("Host 无需进入观众等待队列");
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let previous = "";
    const emit = () => {
      try {
        const currentSession = authService.authenticate(token);
        const payload = JSON.stringify(
          toPublicEntry(roomService.getAccountRoomState(currentSession)),
        );
        if (payload !== previous) {
          previous = payload;
          reply.raw.write(`event: room-state\ndata: ${payload}\n\n`);
        } else {
          reply.raw.write(": keepalive\n\n");
        }
      } catch {
        reply.raw.write(
          `event: session-expired\ndata: {"state":"expired"}\n\n`,
        );
        reply.raw.end();
      }
    };
    emit();
    const timer = setInterval(emit, 2_000);
    timer.unref();
    request.raw.once("close", () => clearInterval(timer));
  });

  app.get(
    "/api/v1/admin/active-room",
    { schema: { response: { 200: activeRoomSummarySchema } } },
    async (request, reply) => {
      const account = authService.authenticate(getAccountCookie(request));
      authService.requireHost(account);
      const room = roomService.getActiveRoomSummary(account.account_id);
      reply.header("Cache-Control", "no-store");
      if (!room) return null;
      const live =
        room.mode === "live"
          ? await transportService.getLiveStatus(room.id)
          : {
              state: "offline" as const,
              hasVideo: false,
              hasAudio: false,
              videoTrackCount: 0,
              audioTrackCount: 0,
              sourceBitrateMbps: null,
              sourcePacketLossPercent: null,
              sourceHealth: "unknown" as const,
              checkedAt: new Date(now()).toISOString(),
            };
      return { ...room, live };
    },
  );

  app.post(
    "/api/v1/rooms",
    {
      schema: {
        body: z.object({}).strict(),
        response: { 201: roomSessionResponseSchema },
      },
    },
    (request, reply) => {
      const account = authService.authenticate(getAccountCookie(request));
      authService.requireHost(account);
      authService.requireCsrf(account, getHeader(request, "x-csrf-token"));
      const result = roomService.createAccountRoom(
        account,
        transportService.getStablePublishPath(),
      );
      reply.header("Cache-Control", "no-store");
      reply.status(201);
      return {
        room: { id: result.roomId },
        member: {
          id: result.memberId,
          nickname: result.nickname,
          role: result.role,
        },
        csrfToken: rotateUnifiedCsrf(authService, account),
        expiresAt: new Date(account.absolute_expires_at).toISOString(),
      };
    },
  );

  app.patch(
    "/api/v1/rooms/:roomId",
    {
      schema: {
        params: roomParamsSchema,
        body: updateRoomRequestSchema,
        response: {
          200: z.object({
            id: z.string().uuid(),
            status: z.enum(["active", "closed"]),
          }),
        },
      },
    },
    (request) => {
      const account = authService.authenticate(getAccountCookie(request));
      authService.requireHost(account);
      authService.requireCsrf(account, getHeader(request, "x-csrf-token"));
      const result = roomService.updateRoom(
        account.account_id,
        request.params.roomId,
        request.body,
      );
      if (result.status === "closed")
        hub.closeRoom(result.id, 4010, "room closed");
      return result;
    },
  );

  app.delete(
    "/api/v1/admin/active-room",
    {
      schema: {
        response: {
          200: z.object({ id: z.string().uuid(), status: z.literal("closed") }),
        },
      },
    },
    (request) => {
      const account = authService.authenticate(getAccountCookie(request));
      authService.requireHost(account);
      authService.requireCsrf(account, getHeader(request, "x-csrf-token"));
      const result = roomService.closeActiveRoom(account.account_id);
      hub.closeRoom(result.id, 4010, "room force closed");
      return result;
    },
  );

  app.delete(
    "/api/v1/rooms/:roomId",
    {
      schema: {
        params: roomParamsSchema,
        response: {
          200: z.object({ id: z.string().uuid(), status: z.literal("closed") }),
        },
      },
    },
    (request) => {
      const identity = roomService.authenticate(
        getAccountCookie(request),
        request.params.roomId,
      );
      roomService.requireCsrf(identity, getHeader(request, "x-csrf-token"));
      const result = roomService.closeByHost(identity);
      hub.closeRoom(result.id, 4010, "room closed");
      return result;
    },
  );

  app.post(
    "/api/v1/rooms/:roomId/members/:memberId/kick",
    {
      schema: {
        params: z.object({
          roomId: z.string().uuid(),
          memberId: z.string().uuid(),
        }),
        body: kickMemberRequestSchema,
        response: { 200: roomSnapshotSchema },
      },
    },
    (request) => {
      const identity = roomService.authenticate(
        getAccountCookie(request),
        request.params.roomId,
      );
      roomService.requireCsrf(identity, getHeader(request, "x-csrf-token"));
      roomService.kickMember(
        identity,
        request.params.memberId,
        request.body.reason,
      );
      hub.closeMember(
        identity.roomId,
        request.params.memberId,
        4003,
        "member removed",
      );
      const snapshot = roomService.getSnapshot(identity.roomId);
      hub.broadcast(
        identity.roomId,
        createEnvelope(identity.roomId, "room.snapshot", snapshot, now),
      );
      return snapshot;
    },
  );

  app.get(
    "/api/v1/rooms/:roomId/bootstrap",
    {
      schema: {
        params: roomParamsSchema,
        response: {
          200: z.object({
            snapshot: roomSnapshotSchema,
            memberId: z.string().uuid(),
            csrfToken: z.string(),
            serverNow: z.iso.datetime(),
          }),
        },
      },
    },
    (request, reply) => {
      const identity = roomService.authenticate(
        getAccountCookie(request),
        request.params.roomId,
      );
      roomService.touch(identity);
      reply.header("Cache-Control", "no-store");
      return {
        snapshot: roomService.getSnapshot(identity.roomId),
        memberId: identity.memberId,
        csrfToken: roomService.rotateCsrf(identity),
        serverNow: new Date(now()).toISOString(),
      };
    },
  );

  app.post(
    "/api/v1/rooms/:roomId/leave",
    {
      schema: {
        params: roomParamsSchema,
        response: { 204: emptyResponseSchema },
      },
    },
    (request, reply) => {
      const identity = roomService.authenticate(
        getAccountCookie(request),
        request.params.roomId,
      );
      roomService.requireCsrf(identity, getHeader(request, "x-csrf-token"));
      roomService.leave(identity);
      const snapshot = roomService.getSnapshot(identity.roomId);
      hub.closeMember(identity.roomId, identity.memberId, 4001, "member left");
      hub.broadcast(
        identity.roomId,
        createEnvelope(identity.roomId, "room.snapshot", snapshot, now),
      );
      reply.status(204);
      return null;
    },
  );

  app.post(
    "/api/v1/admin/obs-credentials/rotate",
    {
      schema: {
        body: z.object({ confirmation: z.literal("重新生成OBS配置") }),
        response: {
          200: z.object({
            url: z.url(),
            token: z.string(),
            path: z.string(),
            expiresAt: z.string(),
          }),
        },
      },
    },
    (request) => {
      const account = authService.authenticate(getAccountCookie(request));
      authService.requireHost(account);
      authService.requireCsrf(account, getHeader(request, "x-csrf-token"));
      return transportService.rotateStablePublishCredential();
    },
  );

  app.get(
    "/api/v1/time",
    {
      schema: {
        response: {
          200: z.object({
            receivedAtMs: z.number().int(),
            sentAtMs: z.number().int(),
            origin: z.url(),
          }),
        },
      },
    },
    (request, reply) => {
      const receivedAtMs = now();
      authService.authenticate(getAccountCookie(request));
      reply.header("Cache-Control", "no-store");
      return { receivedAtMs, sentAtMs: now(), origin: publicOrigin };
    },
  );

  for (const legacyPath of [
    "/api/v1/admin/login",
    "/api/v1/admin/session",
    "/api/v1/admin/logout",
    "/api/v1/admin/active-room/host-session",
    "/api/v1/rooms/active/join",
  ]) {
    app.all(legacyPath, (_request, reply) =>
      reply.status(410).send({
        error: {
          code: "LEGACY_AUTH_REMOVED",
          message: "旧登录入口已经停用",
          requestId: "legacy-auth",
        },
      }),
    );
  }
}

function registerWebSocketRoute(
  app: FastifyInstance,
  roomService: RoomService,
  programService: ProgramService,
  hub: RoomHub,
  publicOrigin: string,
  now: () => number,
): void {
  app.get(
    "/api/v1/rooms/:roomId/ws",
    { websocket: true, schema: { params: roomParamsSchema } },
    (socket: WebSocket, request) => {
      let identity: RoomIdentity;
      try {
        if (request.headers.origin !== publicOrigin)
          throw forbidden("Origin 不受信任");
        const protocols = request.headers["sec-websocket-protocol"]
          ?.split(",")
          .map((value) => value.trim());
        if (!protocols?.includes("simplewatch.v1")) {
          socket.close(1002, "subprotocol required");
          return;
        }
        const params = roomParamsSchema.parse(request.params);
        identity = roomService.authenticate(
          getAccountCookie(request),
          params.roomId,
        );
      } catch {
        socket.close(4001, "session invalid");
        return;
      }

      roomService.touch(identity);
      const connectedMemberId = identity.memberId;
      const authorize = (): boolean => {
        try {
          const current = roomService.authenticate(
            getAccountCookie(request),
            identity.roomId,
          );
          if (current.memberId !== connectedMemberId)
            throw forbidden("席位已变化");
          identity = current;
          return true;
        } catch {
          socket.close(4001, "session invalid");
          return false;
        }
      };
      const playbackAccess = {
        role: identity.role,
        nickname: identity.nickname,
        authorize,
      };
      const remove = hub.add(
        identity.roomId,
        identity.memberId,
        socket,
        playbackAccess,
      );
      let windowStartedAt = now();
      let messagesInWindow = 0;
      let lastPongAt = now();
      const heartbeat = setInterval(() => {
        if (now() - lastPongAt >= 60_000) {
          socket.close(4000, "heartbeat timeout");
          return;
        }
        socket.ping();
      }, 20_000);
      heartbeat.unref();
      socket.on("pong", () => {
        if (!authorize()) return;
        lastPongAt = now();
        roomService.touch(identity);
      });
      socket.on("close", () => {
        clearInterval(heartbeat);
        remove();
      });
      socket.on("message", (data: RawData) => {
        let rejectedCommandId: string | undefined;
        let isPlaybackStatus = false;
        const receivedAtMs = now();
        if (!authorize()) return;
        roomService.touch(identity);
        if (receivedAtMs - windowStartedAt >= 1000) {
          windowStartedAt = receivedAtMs;
          messagesInWindow = 0;
        }
        messagesInWindow += 1;
        if (messagesInWindow > 20) {
          socket.close(4008, "rate limited");
          return;
        }

        try {
          const rawText = rawDataToText(data);
          const raw: unknown = JSON.parse(rawText);
          if (isEnvelopeType(raw, "room.hello")) {
            const requestId = z
              .object({ id: z.string().uuid() })
              .safeParse(raw);
            const snapshot = roomService.getSnapshot(identity.roomId);
            sendEnvelope(
              socket,
              identity.roomId,
              "room.snapshot",
              snapshot,
              now,
              requestId.success ? requestId.data.id : undefined,
            );
            const hello = z
              .object({
                payload: z.object({ playbackStatus: z.boolean().optional() }),
              })
              .safeParse(raw);
            if (hello.success && hello.data.payload.playbackStatus) {
              hub.publishPlaybackSummary(identity.roomId, socket);
            }
            return;
          }

          if (isEnvelopeType(raw, "playback.status")) {
            isPlaybackStatus = true;
            if (Buffer.byteLength(rawText, "utf8") > 4096) {
              throw new AppError(
                413,
                "PLAYBACK_STATUS_TOO_LARGE",
                "播放观测消息超过 4KiB",
              );
            }
            const observation = playbackStatusEnvelopeSchema.safeParse(raw);
            if (
              !observation.success ||
              observation.data.roomId !== identity.roomId
            ) {
              throw new AppError(
                400,
                "INVALID_PLAYBACK_STATUS",
                "播放观测消息无效",
              );
            }
            if (
              !hub.recordPlaybackStatus(
                identity.roomId,
                identity.memberId,
                observation.data.payload,
                playbackAccess,
              )
            ) {
              throw new AppError(
                429,
                "PLAYBACK_STATUS_RATE_LIMITED",
                "播放观测每秒最多一次",
              );
            }
            return;
          }

          const clockMessage = clockPingEnvelopeSchema.safeParse(raw);
          if (clockMessage.success && clockMessage.data.type === "clock.ping") {
            sendEnvelope(
              socket,
              identity.roomId,
              "clock.pong",
              {
                clientSentAtMs: clockMessage.data.payload.clientSentAtMs,
                serverReceivedAtMs: receivedAtMs,
                serverSentAtMs: now(),
              },
              now,
            );
            return;
          }

          const commandMessage = commandEnvelopeSchema.safeParse(raw);
          if (
            commandMessage.success &&
            commandMessage.data.type === "room.command"
          ) {
            rejectedCommandId = commandMessage.data.payload.commandId;
            if (commandMessage.data.roomId !== identity.roomId)
              throw forbidden("房间不匹配");
            const previousRevision = roomService.getSnapshot(
              identity.roomId,
            ).revision;
            const snapshot = roomService.applyCommand(
              identity,
              commandMessage.data.payload,
            );
            const currentSnapshot =
              snapshot.revision > previousRevision
                ? snapshot
                : roomService.getSnapshot(identity.roomId);
            sendEnvelope(
              socket,
              identity.roomId,
              "room.command.applied",
              {
                commandId: rejectedCommandId,
                revision: snapshot.revision,
                snapshot,
                currentSnapshot,
              },
              now,
            );
            // A retry receives its original receipt, but must never replay old state to peers.
            if (snapshot.revision > previousRevision) {
              hub.broadcast(
                identity.roomId,
                createEnvelope(identity.roomId, "room.snapshot", snapshot, now),
              );
            }
            return;
          }

          const progressMessage = playbackProgressEnvelopeSchema.safeParse(raw);
          if (
            progressMessage.success &&
            progressMessage.data.type === "playback.progress"
          ) {
            if (identity.role !== "host") {
              throw forbidden("只有主持人可以上报播放进度");
            }
            programService.recordProgress(
              identity.roomId,
              progressMessage.data.payload,
            );
            return;
          }

          throw new AppError(
            400,
            "INVALID_MESSAGE",
            "无法识别的 WebSocket 消息",
          );
        } catch (error) {
          const appError =
            error instanceof AppError
              ? error
              : new AppError(400, "INVALID_MESSAGE", "消息无效");
          sendEnvelope(
            socket,
            identity.roomId,
            isPlaybackStatus
              ? "playback.status.rejected"
              : "room.command.rejected",
            {
              commandId: rejectedCommandId,
              code: appError.code,
              message: appError.message,
              details: appError.details,
            },
            now,
          );
        }
      });
    },
  );
}

function setAccountCookie(
  reply: FastifyReply,
  value: string,
  absoluteExpiresAt: number,
): void {
  reply.setCookie("__Host-sw_session", value, {
    secure: true,
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    expires: new Date(absoluteExpiresAt),
  });
}

function getAccountCookie(request: FastifyRequest): string | undefined {
  return request.cookies["__Host-sw_session"];
}

function rotateUnifiedCsrf(
  authService: AuthService,
  session: ReturnType<AuthService["authenticate"]>,
): string {
  return authService.rotateCsrf(session);
}

function toPublicEntry(entry: AccountRoomEntry) {
  if (entry.state !== "room") return entry;
  return {
    state: "room" as const,
    roomId: entry.roomId,
    memberId: entry.memberId,
    nickname: entry.nickname,
    role: entry.role,
    tookOver: entry.tookOverSessionHash !== null,
  };
}

function getHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sendError(
  reply: FastifyReply,
  request: FastifyRequest,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
): FastifyReply {
  return reply.status(statusCode).send({
    error: {
      code,
      message,
      requestId: request.id,
      ...(details === undefined ? {} : { details }),
    },
  });
}

function createEnvelope(
  roomId: string,
  type: string,
  payload: unknown,
  now: () => number,
  replyTo?: string,
) {
  return {
    v: 1 as const,
    type,
    id: uuidv7(),
    roomId,
    sentAtMs: now(),
    payload,
    ...(replyTo ? { replyTo } : {}),
  };
}

function sendEnvelope(
  socket: { send(data: string): void },
  roomId: string,
  type: string,
  payload: unknown,
  now: () => number,
  replyTo?: string,
): void {
  socket.send(
    JSON.stringify(createEnvelope(roomId, type, payload, now, replyTo)),
  );
}

function isEnvelopeType(value: unknown, type: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "v" in value &&
    value.v === 1 &&
    "type" in value &&
    value.type === type
  );
}

function rawDataToText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}
