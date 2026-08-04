import { timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";

import { unauthorized } from "./errors.js";
import type { AdminEventHub } from "./admin-event-hub.js";
import type { EdgeEvictionService } from "./services/edge-eviction-service.js";
import type { EdgeCatalogService } from "./services/edge-catalog-service.js";
import type { ProgramService } from "./services/program-service.js";

export function registerEdgeInternalRoutes(
  app: FastifyInstance,
  programService: ProgramService,
  evictionService: EdgeEvictionService,
  catalogService: EdgeCatalogService,
  events: AdminEventHub,
  internalToken: string,
): void {
  app.post("/api/v1/internal/edge/reconcile", (request, reply) => {
    requireInternal(request, internalToken);
    programService.reconcileRoomBindings();
    programService.recomputeActiveProtection();
    evictionService.reconcile();
    catalogService.reconcileStaging();
    events.publish("edge.cache.changed");
    events.publish("program.queue.changed");
    events.publish("storage.changed");
    reply.status(204);
    return null;
  });
}

function requireInternal(request: FastifyRequest, expected: string): void {
  const value = request.headers["x-internal-token"];
  const provided = Array.isArray(value) ? value[0] : value;
  const left = Buffer.from(provided ?? "");
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw unauthorized("内部服务凭据无效");
  }
}
