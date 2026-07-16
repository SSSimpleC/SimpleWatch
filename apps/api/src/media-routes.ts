import { timingSafeEqual } from "node:crypto";

import { z } from "zod";

import {
  mediaSchema,
  subtitleUploadRequestSchema,
  uploadAuthorizeRequestSchema,
  uploadStateSchema,
  workerResultSchema,
} from "@simplewatch/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { unauthorized } from "./errors.js";
import type { AuthService } from "./services/auth-service.js";
import type {
  ContentIdentity,
  MediaService,
} from "./services/media-service.js";
import type { RoomService } from "./services/room-service.js";

const mediaParamsSchema = z.object({ mediaId: z.string().uuid() });
const uploadParamsSchema = z.object({ uploadId: z.string().uuid() });
const jobParamsSchema = z.object({ jobId: z.string().uuid() });
const uploadResponseSchema = z.object({
  id: z.string().uuid(),
  state: uploadStateSchema,
  filename: z.string(),
  mime: z.string(),
  declaredBytes: z.number().int().nonnegative(),
  receivedBytes: z.number().int().nonnegative(),
  expiresAt: z.iso.datetime(),
});

export function registerMediaRoutes(
  baseApp: FastifyInstance,
  authService: AuthService,
  roomService: RoomService,
  mediaService: MediaService,
  internalToken: string,
): void {
  const app = baseApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/v1/media",
    { schema: { response: { 200: z.array(mediaSchema) } } },
    (request) => {
      authenticateHost(request, authService);
      return mediaService.listMedia();
    },
  );

  app.get(
    "/api/v1/media/:mediaId",
    { schema: { params: mediaParamsSchema, response: { 200: mediaSchema } } },
    (request) => {
      const identity = resolveIdentity(request, authService, roomService);
      mediaService.requireAccess(identity, request.params.mediaId);
      return mediaService.getMedia(request.params.mediaId);
    },
  );

  app.route({
    method: ["GET", "HEAD"],
    url: "/api/v1/media/:mediaId/content",
    schema: { params: mediaParamsSchema },
    handler(request, reply) {
      const identity = resolveIdentity(request, authService, roomService);
      const method = request.method === "HEAD" ? "HEAD" : "GET";
      const location = mediaService.createContentUrl(
        identity,
        request.params.mediaId,
        method,
      );
      reply.header("Cache-Control", "no-store");
      return reply.redirect(location, 307);
    },
  });

  app.post(
    "/api/v1/uploads/authorize",
    {
      schema: {
        body: uploadAuthorizeRequestSchema,
        response: {
          201: z.object({
            uploadId: z.string().uuid(),
            tusEndpoint: z.url(),
            uploadToken: z.string(),
            expiresAt: z.iso.datetime(),
            maxChunkBytes: z.number().int().positive(),
          }),
        },
      },
    },
    (request, reply) => {
      const admin = authenticateHost(request, authService);
      authService.requireCsrf(admin, header(request, "x-csrf-token"));
      reply.status(201);
      return mediaService.authorizeUpload(admin.admin_id, request.body);
    },
  );

  app.get(
    "/api/v1/uploads/:uploadId",
    {
      schema: {
        params: uploadParamsSchema,
        response: { 200: uploadResponseSchema },
      },
    },
    (request) => {
      const admin = authenticateHost(request, authService);
      return mediaService.getUpload(admin.admin_id, request.params.uploadId);
    },
  );

  app.delete(
    "/api/v1/uploads/:uploadId",
    { schema: { params: uploadParamsSchema, response: { 204: z.null() } } },
    (request, reply) => {
      const admin = authenticateHost(request, authService);
      authService.requireCsrf(admin, header(request, "x-csrf-token"));
      mediaService.cancelUpload(admin.admin_id, request.params.uploadId);
      reply.status(204);
      return null;
    },
  );

  app.post(
    "/api/v1/admin/media/:mediaId/rescan",
    {
      schema: {
        params: mediaParamsSchema,
        response: { 202: z.object({ jobId: z.string().uuid() }) },
      },
    },
    (request, reply) => {
      const admin = authenticateHost(request, authService);
      authService.requireCsrf(admin, header(request, "x-csrf-token"));
      reply.status(202);
      return mediaService.rescanMedia(admin.admin_id, request.params.mediaId);
    },
  );

  app.post(
    "/api/v1/admin/media/:mediaId/subtitles",
    {
      schema: {
        params: mediaParamsSchema,
        body: subtitleUploadRequestSchema,
        response: { 202: z.object({ jobId: z.string().uuid() }) },
      },
    },
    (request, reply) => {
      const admin = authenticateHost(request, authService);
      authService.requireCsrf(admin, header(request, "x-csrf-token"));
      reply.status(202);
      return mediaService.createSubtitleJob(
        request.params.mediaId,
        request.body,
      );
    },
  );

  app.delete(
    "/api/v1/admin/media/:mediaId",
    { schema: { params: mediaParamsSchema, response: { 204: z.null() } } },
    (request, reply) => {
      const admin = authenticateHost(request, authService);
      authService.requireCsrf(admin, header(request, "x-csrf-token"));
      mediaService.trashMedia(admin.admin_id, request.params.mediaId);
      reply.status(204);
      return null;
    },
  );

  app.get(
    "/api/v1/subtitles/:subtitleId",
    { schema: { params: z.object({ subtitleId: z.string().uuid() }) } },
    (request, reply) => {
      const identity = resolveIdentity(request, authService, roomService);
      reply
        .type("text/vtt; charset=utf-8")
        .header("Cache-Control", "private, no-store");
      return mediaService.readSubtitle(identity, request.params.subtitleId);
    },
  );

  app.post(
    "/api/v1/internal/uploads/complete",
    {
      schema: {
        body: z.object({
          uploadId: z.string().uuid(),
          uploadToken: z.string().min(1),
          filePath: z.string().min(1),
          receivedBytes: z.number().int().nonnegative(),
        }),
      },
    },
    (request, reply) => {
      requireInternal(request, internalToken);
      return reply
        .status(201)
        .send(
          mediaService.completeUpload(
            request.body.uploadId,
            request.body.uploadToken,
            request.body.filePath,
            request.body.receivedBytes,
          ),
        );
    },
  );

  app.post(
    "/api/v1/internal/tus/hooks",
    { schema: { body: z.record(z.string(), z.unknown()) } },
    (request) => {
      requireInternal(request, internalToken);
      const hook = parseTusHook(request.body);
      return mediaService.handleTusHook(hook);
    },
  );

  app.post(
    "/api/v1/internal/imports/sftp",
    {
      schema: {
        body: z.object({
          filename: z.string().min(1).max(255),
          filePath: z.string().min(1),
          bytes: z.number().int().positive(),
        }),
      },
    },
    (request, reply) => {
      requireInternal(request, internalToken);
      return reply.status(201).send(mediaService.importSftpFile(request.body));
    },
  );

  app.post(
    "/api/v1/internal/jobs/claim",
    { schema: { body: z.object({ workerId: z.string().min(1).max(128) }) } },
    (request) => {
      requireInternal(request, internalToken);
      return mediaService.claimJob(request.body.workerId);
    },
  );

  app.post(
    "/api/v1/internal/jobs/:jobId/heartbeat",
    {
      schema: {
        params: jobParamsSchema,
        body: z.object({ leaseToken: z.string(), progress: z.unknown() }),
      },
    },
    (request, reply) => {
      requireInternal(request, internalToken);
      mediaService.heartbeatJob(
        request.params.jobId,
        request.body.leaseToken,
        request.body.progress,
      );
      return reply.status(204).send();
    },
  );

  app.post(
    "/api/v1/internal/jobs/:jobId/result",
    {
      schema: {
        params: jobParamsSchema,
        body: workerResultSchema.extend({ leaseToken: z.string() }),
      },
    },
    (request, reply) => {
      requireInternal(request, internalToken);
      const { leaseToken, ...result } = request.body;
      mediaService.completeJob(request.params.jobId, leaseToken, result);
      return reply.status(204).send();
    },
  );

  app.post(
    "/api/v1/internal/jobs/:jobId/subtitle-result",
    {
      schema: {
        params: jobParamsSchema,
        body: z.object({
          leaseToken: z.string(),
          finalPath: z.string().min(1),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          bytes: z
            .number()
            .int()
            .positive()
            .max(2 * 1024 * 1024),
        }),
      },
    },
    (request, reply) => {
      requireInternal(request, internalToken);
      const { leaseToken, ...result } = request.body;
      mediaService.completeSubtitleJob(
        request.params.jobId,
        leaseToken,
        result,
      );
      return reply.status(204).send();
    },
  );

  app.get("/api/v1/internal/media/authorize", (request, reply) => {
    requireInternal(request, internalToken);
    const method =
      header(request, "x-forwarded-method") === "HEAD" ? "HEAD" : "GET";
    const uri = header(request, "x-forwarded-uri");
    if (!uri) throw unauthorized("缺少原始媒体 URI");
    mediaService.authorizeContent(
      resolveIdentity(request, authService, roomService),
      uri,
      method,
    );
    return reply.status(204).send();
  });

  app.get("/api/v1/internal/tus/authorize", (request, reply) => {
    requireInternal(request, internalToken);
    const uri = header(request, "x-forwarded-uri");
    if (!uri) throw unauthorized("缺少原始上传 URI");
    mediaService.authorizeTusRequest(header(request, "upload-token"), uri);
    return reply.status(204).send();
  });
}

function resolveIdentity(
  request: FastifyRequest,
  authService: AuthService,
  roomService: RoomService,
): ContentIdentity {
  const accountToken = request.cookies["__Host-sw_session"];
  const account = authService.authenticate(accountToken);
  if (account.role === "host") {
    const session = account;
    return {
      kind: "admin",
      sessionHash: session.id_hash,
      expiresAt: session.expires_at,
    };
  }
  const session = roomService.authenticate(accountToken);
  return {
    kind: "room",
    roomId: session.roomId,
    sessionHash: session.sessionHash,
    expiresAt: session.expiresAt,
  };
}

function authenticateHost(request: FastifyRequest, authService: AuthService) {
  const session = authService.authenticate(
    request.cookies["__Host-sw_session"],
  );
  authService.requireHost(session);
  return session;
}

function requireInternal(request: FastifyRequest, expected: string): void {
  const provided = header(request, "x-internal-token");
  if (!provided || !safeEqual(provided, expected)) {
    throw unauthorized("内部服务凭据无效");
  }
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function parseTusHook(body: Readonly<Record<string, unknown>>) {
  const type = typeof body.Type === "string" ? body.Type : "";
  const event = asRecord(body.Event);
  const upload = asRecord(event.Upload);
  const request = asRecord(event.HTTPRequest);
  const headers = asRecord(request.Header);
  const metadataInput = asRecord(upload.MetaData);
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadataInput)) {
    if (typeof value === "string") metadata[key] = value;
  }
  const tokenValue = headers["Upload-Token"] ?? headers["upload-token"];
  const uploadToken: unknown = Array.isArray(tokenValue)
    ? (tokenValue as unknown[])[0]
    : tokenValue;
  return {
    type,
    ...(typeof upload.ID === "string" ? { uploadId: upload.ID } : {}),
    ...(typeof uploadToken === "string" ? { uploadToken } : {}),
    ...(typeof upload.Size === "number" ? { size: upload.Size } : {}),
    ...(typeof upload.Offset === "number" ? { offset: upload.Offset } : {}),
    metadata,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}
