import { createHash } from "node:crypto";

import { v7 as uuidv7 } from "uuid";

import type {
  EdgeCatalogPage,
  EdgeCatalogScanPageRequest,
} from "@simplewatch/contracts";

import type { AppDatabase } from "../database.js";
import { AppError, conflict, notFound } from "../errors.js";

const MAX_CATALOG_PAGE_BYTES = 512 * 1024;

interface ScanRow {
  readonly id: string;
  readonly generation: number;
  readonly state: "collecting" | "committed" | "aborted";
}

type CatalogCommitResult =
  | {
      readonly blocked: false;
      readonly itemCount: number;
      readonly changedCount: number;
    }
  | { readonly blocked: true };

export class EdgeCatalogService {
  public constructor(
    private readonly database: AppDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  public startScan(agentId: string, generation: number) {
    const existing = this.database
      .prepare(
        `SELECT id, generation, state FROM edge_catalog_scans
         WHERE agent_id = ? AND generation = ?`,
      )
      .get(agentId, generation) as ScanRow | undefined;
    if (existing) {
      if (existing.state === "aborted") {
        throw conflict("EDGE_SCAN_ABORTED", "该目录扫描代次已经终止");
      }
      return { scanId: existing.id, generation: existing.generation };
    }
    const latest = this.database
      .prepare(
        `SELECT MAX(generation) AS generation FROM edge_catalog_scans
         WHERE agent_id = ?`,
      )
      .get(agentId) as { readonly generation: number | null };
    if (latest.generation !== null && generation <= latest.generation) {
      throw conflict("EDGE_SCAN_STALE", "目录扫描代次必须单调递增");
    }
    const scanId = uuidv7();
    const timestamp = this.now();
    this.database
      .prepare(
        `INSERT INTO edge_catalog_scans(
           id, agent_id, generation, state, expected_page_count,
           received_page_count, started_at, updated_at, committed_at, aborted_at
         ) VALUES (?, ?, ?, 'collecting', NULL, 0, ?, ?, NULL, NULL)`,
      )
      .run(scanId, agentId, generation, timestamp, timestamp);
    return { scanId, generation };
  }

  public reconcileStaging(): {
    readonly abortedScans: number;
    readonly purgedPages: number;
  } {
    const timestamp = this.now();
    const staleCollectingCutoff = timestamp - 60 * 60 * 1000;
    const purgeCutoff = timestamp - 24 * 60 * 60 * 1000;
    return this.database.transaction(() => {
      const aborted = this.database
        .prepare(
          `UPDATE edge_catalog_scans
           SET state = 'aborted', aborted_at = ?, updated_at = ?
           WHERE state = 'collecting' AND updated_at <= ?`,
        )
        .run(timestamp, timestamp, staleCollectingCutoff);
      const purgedEntries = this.database
        .prepare(
          `DELETE FROM edge_catalog_scan_entries
           WHERE scan_id IN (
             SELECT id FROM edge_catalog_scans
             WHERE state IN ('committed', 'aborted') AND updated_at <= ?
           )`,
        )
        .run(purgeCutoff);
      const purgedPages = this.database
        .prepare(
          `DELETE FROM edge_catalog_scan_pages
           WHERE scan_id IN (
             SELECT id FROM edge_catalog_scans
             WHERE state IN ('committed', 'aborted') AND updated_at <= ?
           )`,
        )
        .run(purgeCutoff);
      return {
        abortedScans: aborted.changes,
        purgedPages: Math.max(purgedEntries.changes, purgedPages.changes),
      };
    })();
  }

  public addPage(
    agentId: string,
    scanId: string,
    input: EdgeCatalogScanPageRequest,
  ): { readonly accepted: boolean } {
    const serialized = JSON.stringify(input);
    const payloadBytes = Buffer.byteLength(serialized);
    if (payloadBytes > MAX_CATALOG_PAGE_BYTES) {
      throw new AppError(
        413,
        "EDGE_CATALOG_PAGE_TOO_LARGE",
        "目录分页超过 512 KiB 上限",
      );
    }
    const payloadSha256 = createHash("sha256").update(serialized).digest("hex");
    const timestamp = this.now();
    return this.database.transaction(() => {
      const scan = this.requireCollectingScan(agentId, scanId);
      if (scan.generation !== input.generation) {
        throw conflict("EDGE_SCAN_GENERATION_MISMATCH", "目录扫描代次不匹配");
      }
      const previous = this.database
        .prepare(
          `SELECT payload_sha256 FROM edge_catalog_scan_pages
           WHERE scan_id = ? AND page_index = ?`,
        )
        .get(scanId, input.pageIndex) as
        | { readonly payload_sha256: string }
        | undefined;
      if (previous) {
        if (previous.payload_sha256 !== payloadSha256) {
          throw conflict(
            "EDGE_SCAN_PAGE_CONFLICT",
            "同一目录分页序号收到了不同内容",
          );
        }
        return { accepted: false };
      }
      this.database
        .prepare(
          `INSERT INTO edge_catalog_scan_pages(
             scan_id, page_index, payload_sha256, entry_count, received_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          scanId,
          input.pageIndex,
          payloadSha256,
          input.entries.length,
          timestamp,
        );
      const insertEntry = this.database.prepare(
        `INSERT INTO edge_catalog_scan_entries(
           scan_id, local_id, relative_path, display_name, bytes, mtime_ms, page_index
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      try {
        for (const entry of input.entries) {
          insertEntry.run(
            scanId,
            entry.localId,
            entry.relativePath,
            entry.displayName,
            entry.bytes,
            entry.mtimeMs,
            input.pageIndex,
          );
        }
      } catch {
        throw conflict(
          "EDGE_SCAN_ENTRY_CONFLICT",
          "目录扫描包含重复文件标识或相对路径",
        );
      }
      this.database
        .prepare(
          `UPDATE edge_catalog_scans
           SET received_page_count = (
             SELECT COUNT(*) FROM edge_catalog_scan_pages WHERE scan_id = ?
           ), updated_at = ? WHERE id = ?`,
        )
        .run(scanId, timestamp, scanId);
      return { accepted: true };
    })();
  }

  public commitScan(
    agentId: string,
    scanId: string,
    generation: number,
    pageCount: number,
  ): { readonly itemCount: number; readonly changedCount: number } {
    const timestamp = this.now();
    const result = this.database.transaction((): CatalogCommitResult => {
      const existing = this.database
        .prepare(
          `SELECT id, generation, state FROM edge_catalog_scans
           WHERE id = ? AND agent_id = ?`,
        )
        .get(scanId, agentId) as ScanRow | undefined;
      if (!existing) throw notFound("目录扫描不存在");
      if (existing.generation !== generation) {
        throw conflict("EDGE_SCAN_GENERATION_MISMATCH", "目录扫描代次不匹配");
      }
      if (existing.state === "committed") {
        const count = this.database
          .prepare(
            "SELECT COUNT(*) AS count FROM edge_catalog_scan_entries WHERE scan_id = ?",
          )
          .get(scanId) as { readonly count: number };
        return {
          blocked: false,
          itemCount: count.count,
          changedCount: 0,
        };
      }
      if (existing.state !== "collecting") {
        throw conflict("EDGE_SCAN_ABORTED", "目录扫描已终止");
      }
      const pages = this.database
        .prepare(
          `SELECT COUNT(*) AS count, MIN(page_index) AS minimum,
                  MAX(page_index) AS maximum
           FROM edge_catalog_scan_pages WHERE scan_id = ?`,
        )
        .get(scanId) as {
        readonly count: number;
        readonly minimum: number | null;
        readonly maximum: number | null;
      };
      if (
        pages.count !== pageCount ||
        (pageCount > 0 &&
          (pages.minimum !== 0 || pages.maximum !== pageCount - 1))
      ) {
        throw conflict("EDGE_SCAN_INCOMPLETE", "目录扫描分页尚未完整到达云端");
      }

      const entries = this.database
        .prepare(
          `SELECT local_id, relative_path, display_name, bytes, mtime_ms
           FROM edge_catalog_scan_entries WHERE scan_id = ?
           ORDER BY page_index, relative_path`,
        )
        .all(scanId) as Array<{
        readonly local_id: string;
        readonly relative_path: string;
        readonly display_name: string;
        readonly bytes: number;
        readonly mtime_ms: number;
      }>;
      if (
        this.guardSuspiciousCatalogReduction(
          agentId,
          scanId,
          generation,
          entries,
          timestamp,
        )
      ) {
        return { blocked: true };
      }
      let changedCount = 0;
      for (const entry of entries) {
        const item = this.database
          .prepare(
            `SELECT id, current_version_id FROM edge_catalog_items
             WHERE agent_id = ? AND local_id = ?`,
          )
          .get(agentId, entry.local_id) as
          | { readonly id: string; readonly current_version_id: string | null }
          | undefined;
        if (!item) {
          const itemId = uuidv7();
          const versionId = uuidv7();
          this.database
            .prepare(
              `INSERT INTO edge_catalog_items(
                 id, agent_id, local_id, relative_path, display_name,
                 source_state, first_seen_at, last_seen_at, missing_at,
                 created_at, updated_at, current_version_id
               ) VALUES (?, ?, ?, ?, ?, 'present', ?, ?, NULL, ?, ?, NULL)`,
            )
            .run(
              itemId,
              agentId,
              entry.local_id,
              entry.relative_path,
              entry.display_name,
              timestamp,
              timestamp,
              timestamp,
              timestamp,
            );
          this.insertVersion(itemId, versionId, 1, entry, timestamp);
          this.database
            .prepare(
              "UPDATE edge_catalog_items SET current_version_id = ? WHERE id = ?",
            )
            .run(versionId, itemId);
          changedCount += 1;
          continue;
        }
        const version = item.current_version_id
          ? (this.database
              .prepare(
                `SELECT version_number, bytes, mtime_ms FROM edge_catalog_versions
                 WHERE id = ?`,
              )
              .get(item.current_version_id) as
              | {
                  readonly version_number: number;
                  readonly bytes: number;
                  readonly mtime_ms: number;
                }
              | undefined)
          : undefined;
        if (
          !version ||
          version.bytes !== entry.bytes ||
          version.mtime_ms !== entry.mtime_ms
        ) {
          if (item.current_version_id) {
            this.database
              .prepare(
                `UPDATE edge_catalog_versions SET source_state = 'changed'
                 WHERE id = ?`,
              )
              .run(item.current_version_id);
          }
          const versionId = uuidv7();
          this.insertVersion(
            item.id,
            versionId,
            (version?.version_number ?? 0) + 1,
            entry,
            timestamp,
          );
          this.database
            .prepare(
              "UPDATE edge_catalog_items SET current_version_id = ? WHERE id = ?",
            )
            .run(versionId, item.id);
          changedCount += 1;
        } else if (item.current_version_id) {
          this.database
            .prepare(
              `UPDATE edge_catalog_versions
               SET source_state = 'present', missing_at = NULL
               WHERE id = ?`,
            )
            .run(item.current_version_id);
        }
        this.database
          .prepare(
            `UPDATE edge_catalog_items
             SET relative_path = ?, display_name = ?, source_state = 'present',
                 last_seen_at = ?, missing_at = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            entry.relative_path,
            entry.display_name,
            timestamp,
            timestamp,
            item.id,
          );
      }

      this.database
        .prepare(
          `UPDATE edge_catalog_items
           SET source_state = 'missing', missing_at = COALESCE(missing_at, ?),
               updated_at = ?
           WHERE agent_id = ? AND NOT EXISTS (
             SELECT 1 FROM edge_catalog_scan_entries e
             WHERE e.scan_id = ? AND e.local_id = edge_catalog_items.local_id
           )`,
        )
        .run(timestamp, timestamp, agentId, scanId);
      this.database
        .prepare(
          `UPDATE edge_catalog_versions
           SET source_state = 'missing', missing_at = COALESCE(missing_at, ?)
           WHERE id IN (
             SELECT current_version_id FROM edge_catalog_items
             WHERE agent_id = ? AND source_state = 'missing'
           )`,
        )
        .run(timestamp, agentId);
      this.database
        .prepare(
          `UPDATE edge_catalog_scans
           SET state = 'committed', expected_page_count = ?,
               received_page_count = ?, committed_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(pageCount, pageCount, timestamp, timestamp, scanId);
      this.database
        .prepare(
          `UPDATE edge_agents
           SET last_complete_scan_at = ?, last_seen_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(timestamp, timestamp, timestamp, agentId);
      return {
        blocked: false,
        itemCount: entries.length,
        changedCount,
      };
    })();
    if (result.blocked) {
      throw conflict(
        "EDGE_CATALOG_REDUCTION_REQUIRES_CONFIRMATION",
        "目录异常减少，必须由下一代扫描提交相同快照后才会生效",
      );
    }
    return {
      itemCount: result.itemCount,
      changedCount: result.changedCount,
    };
  }

  private guardSuspiciousCatalogReduction(
    agentId: string,
    scanId: string,
    generation: number,
    entries: readonly {
      readonly local_id: string;
      readonly relative_path: string;
      readonly display_name: string;
      readonly bytes: number;
      readonly mtime_ms: number;
    }[],
    timestamp: number,
  ): boolean {
    const current = this.database
      .prepare(
        `SELECT COUNT(*) AS item_count, COALESCE(SUM(v.bytes), 0) AS bytes
         FROM edge_catalog_items i
         JOIN edge_catalog_versions v ON v.id = i.current_version_id
         WHERE i.agent_id = ? AND i.source_state = 'present'`,
      )
      .get(agentId) as { readonly item_count: number; readonly bytes: number };
    const nextBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
    const removedCount = current.item_count - entries.length;
    const suspicious =
      current.item_count > 0 &&
      (entries.length === 0 ||
        (removedCount >= 10 && entries.length * 2 <= current.item_count) ||
        (current.bytes > 0 && nextBytes * 2 <= current.bytes));
    if (!suspicious) {
      this.database
        .prepare(
          `UPDATE edge_agents
           SET catalog_guard_fingerprint = NULL,
               catalog_guard_generation = NULL, catalog_guarded_at = NULL
           WHERE id = ?`,
        )
        .run(agentId);
      return false;
    }

    const fingerprint = createHash("sha256")
      .update(
        entries
          .map(
            (entry) =>
              `${entry.local_id}\0${entry.relative_path}\0${entry.bytes}\0${entry.mtime_ms}`,
          )
          .join("\n"),
      )
      .digest("hex");
    const pending = this.database
      .prepare(
        `SELECT catalog_guard_fingerprint, catalog_guard_generation
         FROM edge_agents WHERE id = ?`,
      )
      .get(agentId) as {
      readonly catalog_guard_fingerprint: string | null;
      readonly catalog_guard_generation: number | null;
    };
    if (
      pending.catalog_guard_fingerprint === fingerprint &&
      pending.catalog_guard_generation !== null &&
      pending.catalog_guard_generation < generation
    ) {
      this.database
        .prepare(
          `UPDATE edge_agents
           SET catalog_guard_fingerprint = NULL,
               catalog_guard_generation = NULL, catalog_guarded_at = NULL
           WHERE id = ?`,
        )
        .run(agentId);
      return false;
    }

    this.database
      .prepare(
        `UPDATE edge_agents
         SET catalog_guard_fingerprint = ?, catalog_guard_generation = ?,
             catalog_guarded_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(fingerprint, generation, timestamp, timestamp, agentId);
    this.database
      .prepare(
        `UPDATE edge_catalog_scans
         SET state = 'aborted', aborted_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(timestamp, timestamp, scanId);
    return true;
  }

  public listCatalog(
    agentId: string | undefined,
    limit = 100,
    cursorValue?: string,
    search?: string,
  ): EdgeCatalogPage {
    const cursor = cursorValue ? decodeCatalogCursor(cursorValue) : null;
    const searchPattern = search ? `%${escapeLike(search)}%` : null;
    const rows = this.database
      .prepare(
        `SELECT i.id, i.relative_path, i.display_name,
                CASE WHEN v.source_state = 'changed' THEN 'changed'
                     ELSE i.source_state END AS source_state,
                v.id AS version_id, v.bytes, v.mtime_ms, v.sha256,
                t.state AS transfer_state
         FROM edge_catalog_items i
         JOIN edge_catalog_versions v ON v.id = i.current_version_id
         LEFT JOIN edge_transfer_jobs t ON t.id = (
           SELECT id FROM edge_transfer_jobs
           WHERE catalog_version_id = v.id ORDER BY created_at DESC LIMIT 1
         )
         WHERE (? IS NULL OR i.agent_id = ?)
           AND (
             ? IS NULL
             OR i.relative_path LIKE ? ESCAPE '\\'
             OR i.display_name LIKE ? ESCAPE '\\'
           )
           AND (
             ? IS NULL OR i.relative_path > ?
             OR (i.relative_path = ? AND i.id > ?)
           )
         ORDER BY i.relative_path, i.id LIMIT ?`,
      )
      .all(
        agentId ?? null,
        agentId ?? null,
        searchPattern,
        searchPattern,
        searchPattern,
        cursor?.relativePath ?? null,
        cursor?.relativePath ?? null,
        cursor?.relativePath ?? null,
        cursor?.id ?? null,
        limit + 1,
      ) as Array<{
      readonly id: string;
      readonly relative_path: string;
      readonly display_name: string;
      readonly source_state: "present" | "missing" | "changed";
      readonly version_id: string;
      readonly bytes: number;
      readonly mtime_ms: number;
      readonly sha256: string | null;
      readonly transfer_state: string | null;
    }>;
    const hasMore = rows.length > limit;
    const visibleRows = hasMore ? rows.slice(0, limit) : rows;
    const last = visibleRows.at(-1);
    return {
      items: visibleRows.map((row) => ({
        id: row.id,
        versionId: row.version_id,
        relativePath: row.relative_path,
        displayName: row.display_name,
        bytes: row.bytes,
        mtimeMs: row.mtime_ms,
        sourceState: row.source_state,
        cloudState: toCloudState(row.transfer_state),
        sha256: row.sha256,
      })),
      nextCursor:
        hasMore && last
          ? encodeCatalogCursor({
              id: last.id,
              relativePath: last.relative_path,
            })
          : null,
    };
  }

  private requireCollectingScan(agentId: string, scanId: string): ScanRow {
    const scan = this.database
      .prepare(
        `SELECT id, generation, state FROM edge_catalog_scans
         WHERE id = ? AND agent_id = ?`,
      )
      .get(scanId, agentId) as ScanRow | undefined;
    if (!scan) throw notFound("目录扫描不存在");
    if (scan.state !== "collecting") {
      throw conflict("EDGE_SCAN_NOT_COLLECTING", "目录扫描不再接收分页");
    }
    return scan;
  }

  private insertVersion(
    itemId: string,
    versionId: string,
    versionNumber: number,
    entry: {
      readonly bytes: number;
      readonly mtime_ms: number;
    },
    timestamp: number,
  ): void {
    this.database
      .prepare(
        `INSERT INTO edge_catalog_versions(
           id, catalog_item_id, version_number, bytes, mtime_ms, sha256,
           source_state, first_seen_at, last_verified_at, missing_at, created_at
         ) VALUES (?, ?, ?, ?, ?, NULL, 'present', ?, NULL, NULL, ?)`,
      )
      .run(
        versionId,
        itemId,
        versionNumber,
        entry.bytes,
        entry.mtime_ms,
        timestamp,
        timestamp,
      );
  }
}

function encodeCatalogCursor(cursor: {
  readonly id: string;
  readonly relativePath: string;
}): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCatalogCursor(value: string): {
  readonly id: string;
  readonly relativePath: string;
} {
  try {
    const decoded = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      !("id" in decoded) ||
      !("relativePath" in decoded) ||
      typeof decoded.id !== "string" ||
      typeof decoded.relativePath !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(decoded.id) ||
      decoded.relativePath.length < 1 ||
      decoded.relativePath.length > 2048
    ) {
      throw new Error("invalid cursor");
    }
    return { id: decoded.id, relativePath: decoded.relativePath };
  } catch {
    throw new AppError(400, "EDGE_CATALOG_CURSOR_INVALID", "家庭片库游标无效");
  }
}

function escapeLike(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

function toCloudState(value: string | null) {
  if (value === null) return "not-requested" as const;
  if (value === "ready") return "ready" as const;
  if (value === "evicted") return "evicted" as const;
  if (value === "queued" || value === "leased") return "queued" as const;
  if (value === "validating") return "validating" as const;
  if (value === "uploading" || value === "received")
    return "uploading" as const;
  if (value === "processing") return "processing" as const;
  if (value === "blocked_storage") return "blocked" as const;
  return "failed" as const;
}
