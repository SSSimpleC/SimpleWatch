import { z } from "zod";

import {
  cloudStorageSummarySchema,
  edgeCacheMutationRequestSchema,
  edgeCachePinRequestSchema,
  edgeAgentSummarySchema,
  edgeCacheReplicaSchema,
  edgeCatalogPageSchema,
  edgeCatalogRefreshRequestSchema,
  edgeCatalogRefreshResponseSchema,
  edgeTransferSchema,
  programQueueAddItemsRequestSchema,
  programQueueItemMutationRequestSchema,
  programQueueItemPinRequestSchema,
  programQueueReorderRequestSchema,
  programQueueSchema,
} from "@simplewatch/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { AdminEventHub } from "./admin-event-hub.js";
import type { AuthService } from "./services/auth-service.js";
import type { EdgeAdminService } from "./services/edge-admin-service.js";
import type { EdgeCatalogService } from "./services/edge-catalog-service.js";
import type { EdgeEvictionService } from "./services/edge-eviction-service.js";
import type { EdgeTaskService } from "./services/edge-task-service.js";
import type { ProgramService } from "./services/program-service.js";

const catalogQuerySchema = z.object({
  agentId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().min(1).max(4096).optional(),
  search: z.string().trim().min(1).max(255).optional(),
});
const queueParamsSchema = z.object({ queueId: z.string().uuid() });
const queueItemParamsSchema = queueParamsSchema.extend({
  itemId: z.string().uuid(),
});
const transferParamsSchema = z.object({ transferId: z.string().uuid() });
const cacheParamsSchema = z.object({ replicaId: z.string().uuid() });
const agentParamsSchema = z.object({ agentId: z.string().uuid() });

export function registerEdgeAdminRoutes(
  baseApp: FastifyInstance,
  authService: AuthService,
  edgeAdminService: EdgeAdminService,
  catalogService: EdgeCatalogService,
  taskService: EdgeTaskService,
  programService: ProgramService,
  evictionService: EdgeEvictionService,
  events: AdminEventHub,
): void {
  const app = baseApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/v1/admin/edge/summary",
    {
      schema: {
        response: {
          200: z.object({
            agents: z.array(edgeAgentSummarySchema),
            storage: cloudStorageSummarySchema,
          }),
        },
      },
    },
    (request) => {
      authenticateHost(request, authService);
      return {
        agents: edgeAdminService.listAgents(),
        storage: edgeAdminService.storageSummary(),
      };
    },
  );

  app.post(
    "/api/v1/admin/edge/agents/:agentId/catalog/refresh",
    {
      schema: {
        params: agentParamsSchema,
        body: edgeCatalogRefreshRequestSchema,
        response: { 202: edgeCatalogRefreshResponseSchema },
      },
    },
    (request, reply) => {
      authenticateHostMutation(request, authService);
      const task = taskService.requestCatalogScan(request.params.agentId);
      const agent = edgeAdminService
        .listAgents()
        .find((candidate) => candidate.id === request.params.agentId);
      if (!agent) throw new Error("已排队的 Edge Agent 无法读取");
      events.publish("edge.agent.changed", request.params.agentId);
      reply.status(202);
      return { agent, task };
    },
  );

  app.patch(
    "/api/v1/admin/edge/cache/:replicaId",
    {
      schema: {
        params: cacheParamsSchema,
        body: edgeCachePinRequestSchema,
        response: { 204: z.null() },
      },
    },
    (request, reply) => {
      authenticateHostMutation(request, authService);
      evictionService.setPinned(
        request.params.replicaId,
        request.body.expectedGeneration,
        request.body.expectedRowVersion,
        request.body.pinned,
      );
      programService.recomputeActiveProtection();
      events.publish("edge.cache.changed", request.params.replicaId);
      reply.status(204);
      return null;
    },
  );

  app.post(
    "/api/v1/admin/edge/cache/:replicaId/evict",
    {
      schema: {
        params: cacheParamsSchema,
        body: edgeCacheMutationRequestSchema,
        response: {
          202: z.object({ evictionId: z.string().uuid(), state: z.string() }),
        },
      },
    },
    (request, reply) => {
      authenticateHostMutation(request, authService);
      const result = evictionService.requestEviction(
        request.params.replicaId,
        request.body.expectedGeneration,
        request.body.expectedRowVersion,
      );
      events.publish("edge.cache.changed", request.params.replicaId);
      reply.status(202);
      return result;
    },
  );

  app.get(
    "/api/v1/admin/edge/catalog",
    {
      schema: {
        querystring: catalogQuerySchema,
        response: { 200: edgeCatalogPageSchema },
      },
    },
    (request) => {
      authenticateHost(request, authService);
      return catalogService.listCatalog(
        request.query.agentId,
        request.query.limit,
        request.query.cursor,
        request.query.search,
      );
    },
  );

  app.get(
    "/api/v1/admin/edge/transfers",
    { schema: { response: { 200: z.array(edgeTransferSchema) } } },
    (request) => {
      authenticateHost(request, authService);
      return edgeAdminService.listTransfers();
    },
  );

  app.get(
    "/api/v1/admin/edge/cache",
    { schema: { response: { 200: z.array(edgeCacheReplicaSchema) } } },
    (request) => {
      authenticateHost(request, authService);
      return edgeAdminService.listCache();
    },
  );

  app.get(
    "/api/v1/admin/program",
    { schema: { response: { 200: programQueueSchema.nullable() } } },
    (request) => {
      authenticateHost(request, authService);
      return programService.getActiveQueue();
    },
  );

  app.post(
    "/api/v1/admin/program",
    { schema: { response: { 201: programQueueSchema } } },
    (request, reply) => {
      const host = authenticateHostMutation(request, authService);
      const queue = programService.getOrCreateActiveQueue(host.account_id);
      events.publish("program.queue.changed", queue.id);
      reply.status(201);
      return queue;
    },
  );

  app.post(
    "/api/v1/admin/program/items",
    {
      schema: {
        body: programQueueAddItemsRequestSchema,
        response: { 200: programQueueSchema },
      },
    },
    (request) => {
      const host = authenticateHostMutation(request, authService);
      const queue = programService.addItems(
        host.account_id,
        request.body.expectedRevision,
        request.body.catalogVersionIds,
      );
      events.publish("program.queue.changed", queue.id);
      events.publish("edge.transfer.changed");
      return queue;
    },
  );

  app.put(
    "/api/v1/admin/program/:queueId/order",
    {
      schema: {
        params: queueParamsSchema,
        body: programQueueReorderRequestSchema,
        response: { 200: programQueueSchema },
      },
    },
    (request) => {
      authenticateHostMutation(request, authService);
      const queue = programService.reorder(
        request.params.queueId,
        request.body.expectedRevision,
        request.body.itemIds,
      );
      events.publish("program.queue.changed", queue.id);
      return queue;
    },
  );

  app.delete(
    "/api/v1/admin/program/:queueId/items/:itemId",
    {
      schema: {
        params: queueItemParamsSchema,
        body: programQueueItemMutationRequestSchema,
        response: { 200: programQueueSchema },
      },
    },
    (request) => {
      authenticateHostMutation(request, authService);
      const queue = programService.removeItem(
        request.params.queueId,
        request.params.itemId,
        request.body.expectedRevision,
      );
      events.publish("program.queue.changed", queue.id);
      return queue;
    },
  );

  app.patch(
    "/api/v1/admin/program/:queueId/items/:itemId/pin",
    {
      schema: {
        params: queueItemParamsSchema,
        body: programQueueItemPinRequestSchema,
        response: { 200: programQueueSchema },
      },
    },
    (request) => {
      authenticateHostMutation(request, authService);
      const queue = programService.setItemPinned(
        request.params.queueId,
        request.params.itemId,
        request.body.expectedRevision,
        request.body.pinned,
      );
      events.publish("program.queue.changed", queue.id);
      events.publish("edge.cache.changed");
      return queue;
    },
  );

  app.post(
    "/api/v1/admin/edge/transfers/:transferId/cancel",
    { schema: { params: transferParamsSchema, response: { 204: z.null() } } },
    (request, reply) => {
      authenticateHostMutation(request, authService);
      programService.requestTransferCancellation(request.params.transferId);
      events.publish("edge.transfer.changed", request.params.transferId);
      events.publish("storage.changed");
      reply.status(204);
      return null;
    },
  );

  app.post(
    "/api/v1/admin/edge/transfers/:transferId/retry",
    { schema: { params: transferParamsSchema, response: { 204: z.null() } } },
    (request, reply) => {
      authenticateHostMutation(request, authService);
      programService.retryTransfer(request.params.transferId);
      events.publish("edge.transfer.changed", request.params.transferId);
      reply.status(204);
      return null;
    },
  );

  app.get("/api/v1/admin/events", (request, reply) => {
    authenticateHost(request, authService);
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "private, no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    reply.raw.write(": SimpleWatch admin events\n\n");
    const unsubscribe = events.subscribe((event) => {
      reply.raw.write(`id: ${event.id}\n`);
      reply.raw.write(`event: ${event.type}\n`);
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const keepAlive = setInterval(
      () => reply.raw.write(": keepalive\n\n"),
      15_000,
    );
    keepAlive.unref();
    request.raw.once("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });
}

function authenticateHost(request: FastifyRequest, authService: AuthService) {
  const session = authService.authenticate(
    request.cookies["__Host-sw_session"],
  );
  authService.requireHost(session);
  return session;
}

function authenticateHostMutation(
  request: FastifyRequest,
  authService: AuthService,
) {
  const session = authenticateHost(request, authService);
  const value = request.headers["x-csrf-token"];
  authService.requireCsrf(session, Array.isArray(value) ? value[0] : value);
  return session;
}
