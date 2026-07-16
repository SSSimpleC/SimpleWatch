import { z } from "zod";

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { liveStatusSchema } from "@simplewatch/contracts";

import type { RoomService } from "./services/room-service.js";
import type { OutboxService } from "./services/outbox-service.js";
import type { TransportService } from "./services/transport-service.js";

const roomParamsSchema = z.object({ roomId: z.string().uuid() });
const credentialResponseSchema = z.object({
  purpose: z.enum(["voice", "whep", "whip"]),
  url: z.url(),
  token: z.string().min(1),
  path: z.string().optional(),
  expiresAt: z.iso.datetime(),
});

export function registerTransportRoutes(
  baseApp: FastifyInstance,
  roomService: RoomService,
  transportService: TransportService,
  outboxService: OutboxService,
): void {
  const app = baseApp.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/api/v1/rooms/:roomId/credentials",
    {
      schema: {
        params: roomParamsSchema,
        body: z.object({ purpose: z.enum(["voice", "whep"]) }),
        response: { 200: credentialResponseSchema },
      },
    },
    (request) => {
      const identity = roomService.authenticate(
        request.cookies["__Host-sw_session"],
        request.params.roomId,
      );
      roomService.requireCsrf(identity, header(request, "x-csrf-token"));
      return transportService.issueCredential(identity, request.body.purpose);
    },
  );

  app.get(
    "/api/v1/rooms/:roomId/live/status",
    {
      schema: {
        params: roomParamsSchema,
        response: {
          200: liveStatusSchema,
        },
      },
    },
    (request) => {
      roomService.authenticate(
        request.cookies["__Host-sw_session"],
        request.params.roomId,
      );
      return transportService.getLiveStatus(request.params.roomId);
    },
  );

  app.post(
    "/api/v1/internal/livekit/webhook",
    {
      schema: {
        body: z.string(),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const event = await transportService.receiveLivekitWebhook(
        request.body,
        header(request, "authorization"),
      );
      if (
        event.event === "participant_joined" &&
        event.room?.name.startsWith("voice:") &&
        event.participant?.identity
      ) {
        const roomId = event.room.name.slice("voice:".length);
        const parsed = z.string().uuid().safeParse(roomId);
        const member = z.string().uuid().safeParse(event.participant.identity);
        if (parsed.success && member.success) {
          outboxService.enqueueIfRtcMemberInactive(
            parsed.data,
            member.data,
            `webhook:${event.id || `${roomId}:${member.data}:${event.createdAt}`}`,
          );
        }
      }
      reply.status(204);
      return null;
    },
  );

  app.get(
    "/api/v1/rooms/:roomId/live/publish-config",
    {
      schema: {
        params: roomParamsSchema,
        response: { 200: credentialResponseSchema },
      },
    },
    (request) => {
      const identity = roomService.authenticate(
        request.cookies["__Host-sw_session"],
        request.params.roomId,
      );
      return transportService.getStablePublishCredential(identity);
    },
  );

  app.post(
    "/api/v1/internal/mediamtx/auth",
    {
      schema: {
        body: z
          .object({
            token: z.string().optional(),
            action: z.string().min(1),
            path: z.string(),
            // MediaMTX sends null before a WebRTC session id exists. Rejecting
            // that protocol phase causes needless authentication retries.
            id: z.string().nullish(),
          })
          .passthrough(),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await transportService.authorizeMedia({
        ...request.body,
        id: request.body.id ?? undefined,
      });
      reply.status(204);
      return null;
    },
  );
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
