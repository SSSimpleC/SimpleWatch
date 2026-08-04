import { z } from "zod";

import {
  edgeCatalogScanCommitRequestSchema,
  edgeCatalogScanCreateRequestSchema,
  edgeCatalogScanCreatedSchema,
  edgeCatalogScanPageRequestSchema,
  edgeClaimedJobSchema,
  edgeJobCompleteRequestSchema,
  edgeJobFailRequestSchema,
  edgeJobHeartbeatRequestSchema,
  edgeJobHeartbeatResponseSchema,
  edgeSourceProofSchema,
  edgeTusCredentialSchema,
} from "@simplewatch/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { EdgeAuthService } from "./services/edge-auth-service.js";
import type { AdminEventHub } from "./admin-event-hub.js";
import type { EdgeCatalogService } from "./services/edge-catalog-service.js";
import type { EdgeTaskService } from "./services/edge-task-service.js";
import type { MediaService } from "./services/media-service.js";

const scanParamsSchema = z.object({ scanId: z.string().uuid() });
const jobParamsSchema = z.object({ jobId: z.string().uuid() });
const heartbeatSchema = z.object({
  protocolVersion: z.number().int().positive().optional(),
  softwareVersion: z.string().trim().min(1).max(120).optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
});
const claimQuerySchema = z.object({
  waitSeconds: z.coerce.number().int().min(0).max(25).default(25),
});

export function registerEdgeAgentRoutes(
  baseApp: FastifyInstance,
  authService: EdgeAuthService,
  catalogService: EdgeCatalogService,
  taskService: EdgeTaskService,
  mediaService: MediaService,
  events: AdminEventHub,
): void {
  const app = baseApp.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/api/v1/edge/v1/heartbeat",
    { schema: { body: heartbeatSchema, response: { 204: z.null() } } },
    (request, reply) => {
      const identity = authenticateAgent(request, authService);
      authService.heartbeat(identity, request.body);
      events.publish("edge.agent.changed", identity.agentId);
      reply.status(204);
      return null;
    },
  );

  app.post(
    "/api/v1/edge/v1/catalog/scans",
    {
      schema: {
        body: edgeCatalogScanCreateRequestSchema,
        response: { 201: edgeCatalogScanCreatedSchema },
      },
    },
    (request, reply) => {
      const identity = authenticateAgent(request, authService);
      reply.status(201);
      return catalogService.startScan(
        identity.agentId,
        request.body.generation,
      );
    },
  );

  app.put(
    "/api/v1/edge/v1/catalog/scans/:scanId/pages",
    {
      schema: {
        params: scanParamsSchema,
        body: edgeCatalogScanPageRequestSchema,
        response: { 200: z.object({ accepted: z.boolean() }) },
      },
    },
    (request) => {
      const identity = authenticateAgent(request, authService);
      return catalogService.addPage(
        identity.agentId,
        request.params.scanId,
        request.body,
      );
    },
  );

  app.post(
    "/api/v1/edge/v1/catalog/scans/:scanId/commit",
    {
      schema: {
        params: scanParamsSchema,
        body: edgeCatalogScanCommitRequestSchema,
        response: {
          200: z.object({
            itemCount: z.number().int().nonnegative(),
            changedCount: z.number().int().nonnegative(),
          }),
        },
      },
    },
    (request) => {
      const identity = authenticateAgent(request, authService);
      const result = catalogService.commitScan(
        identity.agentId,
        request.params.scanId,
        request.body.generation,
        request.body.pageCount,
      );
      events.publish("edge.catalog.changed", identity.agentId);
      return result;
    },
  );

  app.get(
    "/api/v1/edge/v1/jobs/claim",
    {
      schema: {
        querystring: claimQuerySchema,
        response: { 200: edgeClaimedJobSchema, 204: z.null() },
      },
    },
    async (request, reply) => {
      const identity = authenticateAgent(request, authService);
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once("close", abort);
      try {
        const job = await taskService.claim(
          identity.agentId,
          request.query.waitSeconds * 1000,
          controller.signal,
        );
        if (!job) {
          reply.status(204);
          return null;
        }
        reply.status(200);
        return job;
      } finally {
        request.raw.off("close", abort);
      }
    },
  );

  app.post(
    "/api/v1/edge/v1/jobs/:jobId/upload-credential",
    {
      schema: {
        params: jobParamsSchema,
        body: z.object({
          leaseToken: z.string().min(32).max(512),
          source: edgeSourceProofSchema,
        }),
        response: { 200: edgeTusCredentialSchema },
      },
    },
    (request) => {
      const identity = authenticateAgent(request, authService);
      const input = taskService.prepareUploadCredential(
        identity.agentId,
        request.params.jobId,
        request.body.leaseToken,
        request.body.source,
      );
      const credential = mediaService.authorizeEdgeUpload(input);
      events.publish("edge.transfer.changed", input.edgeTransferId);
      events.publish("storage.changed");
      return credential;
    },
  );

  app.post(
    "/api/v1/edge/v1/jobs/:jobId/heartbeat",
    {
      schema: {
        params: jobParamsSchema,
        body: edgeJobHeartbeatRequestSchema,
        response: { 200: edgeJobHeartbeatResponseSchema },
      },
    },
    (request) => {
      const identity = authenticateAgent(request, authService);
      const result = taskService.heartbeat(
        identity.agentId,
        request.params.jobId,
        request.body.leaseToken,
        request.body.bytesTransferred,
      );
      events.publish("edge.transfer.changed");
      return result;
    },
  );

  app.post(
    "/api/v1/edge/v1/jobs/:jobId/cancelled",
    {
      schema: {
        params: jobParamsSchema,
        body: z.object({ leaseToken: z.string().min(32).max(512) }),
        response: { 204: z.null() },
      },
    },
    (request, reply) => {
      const identity = authenticateAgent(request, authService);
      const edgeTransferId = taskService.cancelled(
        identity.agentId,
        request.params.jobId,
        request.body.leaseToken,
      );
      if (edgeTransferId) {
        mediaService.removeCancelledEdgeUploadFiles(edgeTransferId);
      }
      events.publish("edge.transfer.changed", edgeTransferId ?? undefined);
      events.publish("storage.changed");
      reply.status(204);
      return null;
    },
  );

  app.post(
    "/api/v1/edge/v1/jobs/:jobId/complete",
    {
      schema: {
        params: jobParamsSchema,
        body: edgeJobCompleteRequestSchema,
        response: { 204: z.null() },
      },
    },
    (request, reply) => {
      const identity = authenticateAgent(request, authService);
      const cancelledTransferId = taskService.complete(
        identity.agentId,
        request.params.jobId,
        request.body.leaseToken,
        request.body.source,
      );
      if (cancelledTransferId) {
        mediaService.removeCancelledEdgeUploadFiles(cancelledTransferId);
      }
      events.publish("edge.transfer.changed");
      events.publish("edge.cache.changed");
      reply.status(204);
      return null;
    },
  );

  app.post(
    "/api/v1/edge/v1/jobs/:jobId/fail",
    {
      schema: {
        params: jobParamsSchema,
        body: edgeJobFailRequestSchema,
        response: { 200: z.object({ state: z.enum(["queued", "failed"]) }) },
      },
    },
    (request) => {
      const identity = authenticateAgent(request, authService);
      const result = taskService.fail(
        identity.agentId,
        request.params.jobId,
        request.body.leaseToken,
        request.body,
      );
      events.publish("edge.transfer.changed");
      return result;
    },
  );
}

function authenticateAgent(request: FastifyRequest, service: EdgeAuthService) {
  const value = request.headers.authorization;
  return service.authenticate(typeof value === "string" ? value : undefined);
}
