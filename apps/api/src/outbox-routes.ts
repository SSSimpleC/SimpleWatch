import { z } from "zod";

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { AppError, unauthorized } from "./errors.js";
import type { OutboxService } from "./services/outbox-service.js";
import { timingSafeEqual } from "node:crypto";

const outboxParamsSchema = z.object({ outboxId: z.string().uuid() });

export function registerOutboxRoutes(
  baseApp: FastifyInstance,
  outboxService: OutboxService,
  internalToken: string,
): void {
  const app = baseApp.withTypeProvider<ZodTypeProvider>();

  app.get("/api/v1/internal/rtc/reconciliation-snapshot", (request) => {
    requireInternal(request, internalToken);
    // A legacy Worker would compare v2 identities with member IDs and remove
    // every new client. Fail closed during a paired App/Worker rollout.
    throw new AppError(
      410,
      "RTC_SNAPSHOT_OBSOLETE",
      "RTC 对账必须先枚举参与者，再调用实时租约校验接口",
    );
  });

  app.post(
    "/api/v1/internal/rtc/validate-participants",
    {
      schema: {
        body: z.object({
          roomId: z.string().uuid(),
          identities: z.array(z.string().min(1).max(512)).max(100),
        }),
        response: { 200: z.object({ invalidIdentities: z.array(z.string()) }) },
      },
    },
    (request) => {
      requireInternal(request, internalToken);
      return {
        invalidIdentities: outboxService.invalidRtcIdentities(
          request.body.roomId,
          request.body.identities,
        ),
      };
    },
  );

  app.post(
    "/api/v1/internal/outbox/claim",
    { schema: { body: z.object({ workerId: z.string().min(1).max(128) }) } },
    (request, reply) => {
      requireInternal(request, internalToken);
      const item = outboxService.claim(request.body.workerId);
      if (!item) return reply.status(204).send();
      return item;
    },
  );

  app.post(
    "/api/v1/internal/outbox/:outboxId/complete",
    {
      schema: {
        params: outboxParamsSchema,
        body: z.object({ leaseToken: z.string().min(1) }),
      },
    },
    (request, reply) => {
      requireInternal(request, internalToken);
      outboxService.complete(request.params.outboxId, request.body.leaseToken);
      return reply.status(204).send();
    },
  );

  app.post(
    "/api/v1/internal/outbox/:outboxId/fail",
    {
      schema: {
        params: outboxParamsSchema,
        body: z.object({
          leaseToken: z.string().min(1),
          error: z.string().min(1).max(1000),
        }),
      },
    },
    (request, reply) => {
      requireInternal(request, internalToken);
      outboxService.fail(
        request.params.outboxId,
        request.body.leaseToken,
        request.body.error,
      );
      return reply.status(204).send();
    },
  );
}

function requireInternal(request: FastifyRequest, expected: string): void {
  const value = request.headers["x-internal-token"];
  const provided = Array.isArray(value) ? value[0] : value;
  if (!provided) throw unauthorized("内部服务凭据无效");
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right))
    throw unauthorized("内部服务凭据无效");
}
