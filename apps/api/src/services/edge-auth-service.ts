import { v7 as uuidv7 } from "uuid";

import type { AppDatabase } from "../database.js";
import { conflict, forbidden, notFound, unauthorized } from "../errors.js";
import { createOpaqueToken, hashToken } from "../security.js";
import type { EdgeTransferLifecycleService } from "./edge-transfer-lifecycle-service.js";

const EDGE_TOKEN_LIFETIME_MILLISECONDS = 90 * 24 * 60 * 60 * 1000;
const EDGE_TOKEN_ROTATION_OVERLAP_MILLISECONDS = 5 * 60 * 1000;

export interface EdgeAgentIdentity {
  readonly agentId: string;
  readonly displayName: string;
  readonly protocolVersion: number;
}

interface EnrollInput {
  readonly displayName: string;
  readonly softwareVersion: string;
  readonly protocolVersion?: number;
  readonly label?: string;
}

export class EdgeAuthService {
  public constructor(
    private readonly database: AppDatabase,
    private readonly now: () => number = Date.now,
    private readonly lifecycle?: EdgeTransferLifecycleService,
  ) {}

  public enroll(input: EnrollInput): {
    readonly agentId: string;
    readonly token: string;
  } {
    const agentId = uuidv7();
    const token = createAgentToken();
    const timestamp = this.now();
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO edge_agents(
             id, display_name, protocol_version, software_version, enabled,
             capabilities_json, last_seen_at, last_complete_scan_at,
             created_at, updated_at, revoked_at
           ) VALUES (?, ?, ?, ?, 1, '{}', NULL, NULL, ?, ?, NULL)`,
        )
        .run(
          agentId,
          input.displayName.trim(),
          input.protocolVersion ?? 1,
          input.softwareVersion.trim(),
          timestamp,
          timestamp,
        );
      this.insertToken(
        agentId,
        token,
        input.label?.trim() || "initial enrollment",
        timestamp + EDGE_TOKEN_LIFETIME_MILLISECONDS,
        timestamp,
      );
    })();
    return { agentId, token };
  }

  public rotate(
    agentId: string,
    label = "rotated credential",
  ): { readonly agentId: string; readonly token: string } {
    const token = createAgentToken();
    const timestamp = this.now();
    this.database.transaction(() => {
      const agent = this.database
        .prepare(
          "SELECT id FROM edge_agents WHERE id = ? AND revoked_at IS NULL",
        )
        .get(agentId);
      if (!agent) throw notFound("Edge Agent 不存在");
      const overlapUntil = timestamp + EDGE_TOKEN_ROTATION_OVERLAP_MILLISECONDS;
      this.database
        .prepare(
          `UPDATE edge_agent_tokens
           SET expires_at = CASE
             WHEN expires_at IS NULL OR expires_at > ? THEN ?
             ELSE expires_at
           END
           WHERE agent_id = ? AND revoked_at IS NULL`,
        )
        .run(overlapUntil, overlapUntil, agentId);
      this.insertToken(
        agentId,
        token,
        label,
        timestamp + EDGE_TOKEN_LIFETIME_MILLISECONDS,
        timestamp,
      );
      this.database
        .prepare("UPDATE edge_agents SET updated_at = ? WHERE id = ?")
        .run(timestamp, agentId);
    })();
    return { agentId, token };
  }

  public revoke(agentId: string): void {
    const timestamp = this.now();
    const activeTransfers = this.database
      .prepare(
        `SELECT id FROM edge_transfer_jobs
         WHERE agent_id = ? AND state NOT IN (
           'ready', 'cancelled', 'incompatible', 'failed', 'evicted'
         )`,
      )
      .all(agentId) as Array<{ readonly id: string }>;
    const activeVerifications = this.database
      .prepare(
        `SELECT DISTINCT json_extract(payload_json, '$.cacheReplicaId') AS cache_replica_id
         FROM edge_agent_tasks
         WHERE agent_id = ? AND kind = 'verify_source'
           AND state IN ('queued', 'leased')`,
      )
      .all(agentId) as Array<{ readonly cache_replica_id: string }>;
    this.database.transaction(() => {
      const result = this.database
        .prepare(
          `UPDATE edge_agents
           SET enabled = 0, revoked_at = ?, updated_at = ?
           WHERE id = ? AND revoked_at IS NULL`,
        )
        .run(timestamp, timestamp, agentId);
      if (result.changes !== 1) throw notFound("Edge Agent 不存在");
      this.database
        .prepare(
          `UPDATE edge_agent_tokens SET revoked_at = ?
           WHERE agent_id = ? AND revoked_at IS NULL`,
        )
        .run(timestamp, agentId);
      this.database
        .prepare(
          `UPDATE edge_agent_tasks
           SET state = 'cancelled', lease_until = NULL, lease_token_hash = NULL,
               updated_at = ?, completed_at = ?
           WHERE agent_id = ? AND state IN ('queued', 'leased')`,
        )
        .run(timestamp, timestamp, agentId);
      for (const verification of activeVerifications) {
        this.database
          .prepare(
            `UPDATE edge_eviction_jobs
             SET state = 'failed', error_code = 'AGENT_REVOKED',
                 error_message = 'Edge Agent 已被撤销', updated_at = ?, completed_at = ?
             WHERE cache_replica_id = ? AND state = 'verifying_source'`,
          )
          .run(timestamp, timestamp, verification.cache_replica_id);
        this.database
          .prepare(
            `UPDATE edge_cache_replicas
             SET state = 'recovery_blocked', protected_reason = 'AGENT_REVOKED',
                 row_version = row_version + 1, updated_at = ?
             WHERE id = ? AND state = 'verifying_source'`,
          )
          .run(timestamp, verification.cache_replica_id);
      }
    })();
    for (const transfer of activeTransfers) {
      this.lifecycle?.finalize(
        transfer.id,
        "cancelled",
        "AGENT_REVOKED",
        "Edge Agent 已被撤销",
        timestamp,
      );
    }
  }

  public authenticate(authorization: string | undefined): EdgeAgentIdentity {
    const token = parseBearer(authorization);
    const timestamp = this.now();
    const row = this.database
      .prepare(
        `SELECT a.id, a.display_name, a.protocol_version
         FROM edge_agent_tokens t
         JOIN edge_agents a ON a.id = t.agent_id
         WHERE t.id_hash = ?
           AND t.revoked_at IS NULL
           AND (t.expires_at IS NULL OR t.expires_at > ?)
           AND a.enabled = 1 AND a.revoked_at IS NULL`,
      )
      .get(hashToken(token), timestamp) as
      | {
          readonly id: string;
          readonly display_name: string;
          readonly protocol_version: number;
        }
      | undefined;
    if (!row) throw unauthorized("Edge Agent 凭据无效或已过期");
    this.database
      .prepare(
        "UPDATE edge_agent_tokens SET last_used_at = ? WHERE id_hash = ?",
      )
      .run(timestamp, hashToken(token));
    return {
      agentId: row.id,
      displayName: row.display_name,
      protocolVersion: row.protocol_version,
    };
  }

  public heartbeat(
    identity: EdgeAgentIdentity,
    input: {
      readonly protocolVersion?: number | undefined;
      readonly softwareVersion?: string | undefined;
      readonly capabilities?: Readonly<Record<string, unknown>> | undefined;
    },
  ): void {
    if (
      input.protocolVersion !== undefined &&
      input.protocolVersion !== identity.protocolVersion
    ) {
      throw conflict(
        "EDGE_PROTOCOL_MISMATCH",
        "Edge Agent 协议版本与登记信息不一致",
      );
    }
    const result = this.database
      .prepare(
        `UPDATE edge_agents
         SET software_version = COALESCE(?, software_version),
             capabilities_json = COALESCE(?, capabilities_json), last_seen_at = ?,
             updated_at = ?
         WHERE id = ? AND enabled = 1 AND revoked_at IS NULL`,
      )
      .run(
        input.softwareVersion ?? null,
        input.capabilities ? JSON.stringify(input.capabilities) : null,
        this.now(),
        this.now(),
        identity.agentId,
      );
    if (result.changes !== 1) throw forbidden("Edge Agent 已被停用");
  }

  private insertToken(
    agentId: string,
    token: string,
    label: string,
    expiresAt: number | null,
    createdAt: number,
  ): void {
    this.database
      .prepare(
        `INSERT INTO edge_agent_tokens(
           id_hash, agent_id, label, expires_at, last_used_at, created_at, revoked_at
         ) VALUES (?, ?, ?, ?, NULL, ?, NULL)`,
      )
      .run(hashToken(token), agentId, label, expiresAt, createdAt);
  }
}

function createAgentToken(): string {
  return `swedge_v1_${createOpaqueToken(32)}`;
}

function parseBearer(value: string | undefined): string {
  if (!value) throw unauthorized("缺少 Edge Agent 凭据");
  const match = /^Bearer ([^\s]+)$/.exec(value);
  if (!match?.[1]?.startsWith("swedge_v1_") || match[1].length < 48) {
    throw unauthorized("Edge Agent 凭据格式无效");
  }
  return match[1];
}
