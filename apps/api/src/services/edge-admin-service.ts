import { statfsSync } from "node:fs";

import type {
  CloudStorageSummary,
  EdgeAgentSummary,
  EdgeCacheReplica,
  EdgeTransfer,
} from "@simplewatch/contracts";

import type { AppDatabase } from "../database.js";

const SAFETY_FLOOR_BYTES = 12 * 1024 * 1024 * 1024;
const CREDENTIAL_EXPIRY_WARNING_MILLISECONDS = 14 * 24 * 60 * 60 * 1000;

export class EdgeAdminService {
  public constructor(
    private readonly database: AppDatabase,
    private readonly storageRoot: string,
    private readonly now: () => number = Date.now,
  ) {}

  public listAgents(): EdgeAgentSummary[] {
    const timestamp = this.now();
    const rows = this.database
      .prepare(
        `SELECT a.id, a.display_name, a.protocol_version, a.software_version,
                a.enabled, a.last_seen_at, a.last_complete_scan_at,
                a.revoked_at, COUNT(i.id) AS item_count,
                CASE
                  WHEN EXISTS (
                    SELECT 1 FROM edge_agent_tokens unlimited
                    WHERE unlimited.agent_id = a.id
                      AND unlimited.revoked_at IS NULL
                      AND unlimited.expires_at IS NULL
                  ) THEN NULL
                  ELSE (
                    SELECT MAX(token.expires_at) FROM edge_agent_tokens token
                    WHERE token.agent_id = a.id
                      AND token.revoked_at IS NULL
                      AND token.expires_at > ?
                  )
                END AS credential_expires_at
         FROM edge_agents a
         LEFT JOIN edge_catalog_items i
           ON i.agent_id = a.id AND i.source_state = 'present'
         GROUP BY a.id ORDER BY a.created_at`,
      )
      .all(timestamp) as Array<{
      readonly id: string;
      readonly display_name: string;
      readonly protocol_version: number;
      readonly software_version: string;
      readonly enabled: number;
      readonly last_seen_at: number | null;
      readonly last_complete_scan_at: number | null;
      readonly revoked_at: number | null;
      readonly item_count: number;
      readonly credential_expires_at: number | null;
    }>;
    return rows.map((row) => {
      const credentialExpiresAt =
        row.revoked_at !== null || row.enabled === 0
          ? null
          : row.credential_expires_at;
      return {
        id: row.id,
        displayName: row.display_name,
        state:
          row.revoked_at !== null || row.enabled === 0
            ? "revoked"
            : row.last_seen_at === null
              ? "offline"
              : timestamp - row.last_seen_at <= 60_000
                ? "online"
                : timestamp - row.last_seen_at <= 5 * 60_000
                  ? "stale"
                  : "offline",
        protocolVersion: row.protocol_version,
        softwareVersion: row.software_version,
        lastSeenAt:
          row.last_seen_at === null
            ? null
            : new Date(row.last_seen_at).toISOString(),
        lastCompleteScanAt:
          row.last_complete_scan_at === null
            ? null
            : new Date(row.last_complete_scan_at).toISOString(),
        catalogItemCount: row.item_count,
        credentialExpiresAt:
          credentialExpiresAt === null
            ? null
            : new Date(credentialExpiresAt).toISOString(),
        credentialExpiringSoon:
          credentialExpiresAt !== null &&
          credentialExpiresAt > timestamp &&
          credentialExpiresAt <=
            timestamp + CREDENTIAL_EXPIRY_WARNING_MILLISECONDS,
      };
    });
  }

  public listTransfers(): EdgeTransfer[] {
    const rows = this.database
      .prepare(
        `SELECT t.*, COALESCE(i.display_name, '已移除的家庭影片') AS display_name
         FROM edge_transfer_jobs t
         LEFT JOIN edge_catalog_versions v ON v.id = t.catalog_version_id
         LEFT JOIN edge_catalog_items i ON i.id = v.catalog_item_id
         ORDER BY t.created_at DESC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const declaredBytes = Number(row.declared_bytes);
      const transferredBytes = Number(row.transferred_bytes);
      const speed =
        typeof row.speed_bytes_per_second === "number" &&
        Number.isFinite(row.speed_bytes_per_second) &&
        row.speed_bytes_per_second >= 0
          ? row.speed_bytes_per_second
          : null;
      return {
        id: String(row.id),
        catalogVersionId:
          typeof row.catalog_version_id === "string"
            ? row.catalog_version_id
            : null,
        displayName: String(row.display_name),
        state: row.state as EdgeTransfer["state"],
        priority: Number(row.priority),
        declaredBytes,
        transferredBytes,
        attempts: Number(row.attempts),
        maxAttempts: Number(row.max_attempts),
        speedBytesPerSecond: speed,
        etaSeconds:
          speed !== null && speed > 0
            ? Math.ceil(Math.max(0, declaredBytes - transferredBytes) / speed)
            : null,
        errorCode: typeof row.error_code === "string" ? row.error_code : null,
        errorMessage:
          typeof row.error_message === "string" ? row.error_message : null,
        updatedAt: new Date(Number(row.updated_at)).toISOString(),
      };
    });
  }

  public listCache(): EdgeCacheReplica[] {
    const rows = this.database
      .prepare(
        `SELECT r.id, r.media_id, r.catalog_version_id, r.state, r.pinned,
                r.generation, r.row_version, r.source_verified_at,
                r.protected_reason, COALESCE(m.display_name, i.display_name,
                '已回收的家庭影片') AS display_name,
                COALESCE(m.bytes, v.bytes, 0) AS bytes
         FROM edge_cache_replicas r
         LEFT JOIN media m ON m.id = r.media_id
         LEFT JOIN edge_catalog_versions v ON v.id = r.catalog_version_id
         LEFT JOIN edge_catalog_items i ON i.id = v.catalog_item_id
         ORDER BY r.updated_at DESC`,
      )
      .all() as Array<{
      readonly id: string;
      readonly media_id: string | null;
      readonly catalog_version_id: string | null;
      readonly state: EdgeCacheReplica["state"];
      readonly pinned: number;
      readonly generation: number;
      readonly row_version: number;
      readonly source_verified_at: number | null;
      readonly protected_reason: string | null;
      readonly display_name: string;
      readonly bytes: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      mediaId: row.media_id,
      catalogVersionId: row.catalog_version_id,
      displayName: row.display_name,
      bytes: row.bytes,
      state: row.state,
      pinned: row.pinned === 1,
      generation: row.generation,
      rowVersion: row.row_version,
      sourceVerifiedAt:
        row.source_verified_at === null
          ? null
          : new Date(row.source_verified_at).toISOString(),
      protectedReason: row.protected_reason,
    }));
  }

  public storageSummary(): CloudStorageSummary {
    const disk = statfsSync(this.storageRoot);
    const totals = this.database
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN r.id IS NULL AND m.trashed_at IS NULL
                        THEN m.bytes ELSE 0 END), 0) AS permanent_bytes,
           COALESCE(SUM(CASE WHEN r.id IS NOT NULL AND r.state != 'evicted'
                             AND m.trashed_at IS NULL
                        THEN m.bytes ELSE 0 END), 0) AS cache_bytes
         FROM media m LEFT JOIN edge_cache_replicas r ON r.media_id = m.id`,
      )
      .get() as {
      readonly permanent_bytes: number;
      readonly cache_bytes: number;
    };
    const reserved = this.database
      .prepare(
        `SELECT COALESCE(SUM(reserved_bytes), 0) AS bytes FROM uploads
         WHERE reserved_bytes > 0`,
      )
      .get() as { readonly bytes: number };
    return {
      capacityBytes: disk.blocks * disk.bsize,
      freeBytes: disk.bavail * disk.bsize,
      reservedBytes: reserved.bytes,
      safetyFloorBytes: SAFETY_FLOOR_BYTES,
      permanentMediaBytes: totals.permanent_bytes,
      edgeCacheBytes: totals.cache_bytes,
      inFlightBytes: reserved.bytes,
    };
  }
}
