import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { CatalogEntry, StoredUpload } from "./types.js";

interface CatalogRow {
  readonly local_id: string;
  readonly relative_path: string;
  readonly display_name: string;
  readonly bytes: number;
  readonly mtime_ms: number;
  readonly revision: string;
}

interface UploadRow {
  readonly job_id: string;
  readonly local_id: string;
  readonly source_revision: string;
  readonly upload_url: string;
  readonly edge_transfer_id: string;
  readonly upload_id: string;
  readonly upload_token: string;
  readonly credential_expires_at: number;
  readonly credential_refresh_after: number;
  readonly chunk_bytes: number;
  readonly offset_bytes: number;
  readonly total_bytes: number;
  readonly updated_at: number;
}

export class AgentState implements Disposable {
  readonly #database: DatabaseSync;

  public constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS agent_meta(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS catalog_items(
        local_id TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        bytes INTEGER NOT NULL CHECK(bytes >= 0),
        mtime_ms INTEGER NOT NULL,
        revision TEXT NOT NULL,
        generation INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS catalog_observations(
        local_id TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        bytes INTEGER NOT NULL CHECK(bytes >= 0),
        mtime_ms INTEGER NOT NULL,
        revision TEXT NOT NULL,
        stable_count INTEGER NOT NULL CHECK(stable_count BETWEEN 1 AND 2),
        observed_generation INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS uploads(
        job_id TEXT PRIMARY KEY,
        local_id TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        upload_url TEXT NOT NULL,
        edge_transfer_id TEXT NOT NULL,
        upload_id TEXT NOT NULL,
        upload_token TEXT NOT NULL,
        credential_expires_at INTEGER NOT NULL,
        credential_refresh_after INTEGER NOT NULL,
        chunk_bytes INTEGER NOT NULL CHECK(chunk_bytes > 0),
        offset_bytes INTEGER NOT NULL CHECK(offset_bytes >= 0),
        total_bytes INTEGER NOT NULL CHECK(total_bytes >= 0),
        updated_at INTEGER NOT NULL
      );
    `);
  }

  public observeCatalog(
    generation: number,
    entries: readonly CatalogEntry[],
  ): CatalogEntry[] {
    this.#transaction(() => {
      const upsert = this.#database.prepare(`
        INSERT INTO catalog_observations(
          local_id, relative_path, display_name, bytes, mtime_ms,
          revision, stable_count, observed_generation
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(local_id) DO UPDATE SET
          relative_path = excluded.relative_path,
          display_name = excluded.display_name,
          bytes = excluded.bytes,
          mtime_ms = excluded.mtime_ms,
          stable_count = CASE
            WHEN catalog_observations.revision = excluded.revision
              THEN MIN(2, catalog_observations.stable_count + 1)
            ELSE 1
          END,
          revision = excluded.revision,
          observed_generation = excluded.observed_generation
      `);
      for (const entry of entries) {
        upsert.run(
          entry.localId,
          entry.relativePath,
          entry.displayName,
          entry.bytes,
          entry.mtimeMs,
          entry.revision,
          generation,
        );
      }
      this.#database
        .prepare(
          "DELETE FROM catalog_observations WHERE observed_generation <> ?",
        )
        .run(generation);
    });
    const rows = this.#database
      .prepare(
        `SELECT local_id, relative_path, display_name, bytes,
                mtime_ms, revision
         FROM catalog_observations
         WHERE stable_count = 2
         ORDER BY relative_path`,
      )
      .all() as unknown as CatalogRow[];
    return rows.map(mapCatalogRow);
  }

  public replaceCatalog(
    generation: number,
    entries: readonly CatalogEntry[],
  ): void {
    this.#transaction(() => {
      const upsert = this.#database.prepare(`
        INSERT INTO catalog_items(
          local_id, relative_path, display_name, bytes,
          mtime_ms, revision, generation
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(local_id) DO UPDATE SET
          relative_path = excluded.relative_path,
          display_name = excluded.display_name,
          bytes = excluded.bytes,
          mtime_ms = excluded.mtime_ms,
          revision = excluded.revision,
          generation = excluded.generation
      `);
      for (const entry of entries) {
        upsert.run(
          entry.localId,
          entry.relativePath,
          entry.displayName,
          entry.bytes,
          entry.mtimeMs,
          entry.revision,
          generation,
        );
      }
      this.#database
        .prepare("DELETE FROM catalog_items WHERE generation <> ?")
        .run(generation);
      this.setMeta("catalog_generation", String(generation));
    });
  }

  public getCatalogItem(localId: string): CatalogEntry | undefined {
    const row = this.#database
      .prepare(
        `SELECT local_id, relative_path, display_name, bytes,
                mtime_ms, revision
         FROM catalog_items WHERE local_id = ?`,
      )
      .get(localId) as unknown as CatalogRow | undefined;
    return row ? mapCatalogRow(row) : undefined;
  }

  public listCatalog(): CatalogEntry[] {
    const rows = this.#database
      .prepare(
        `SELECT local_id, relative_path, display_name, bytes,
                mtime_ms, revision
         FROM catalog_items ORDER BY relative_path`,
      )
      .all() as unknown as CatalogRow[];
    return rows.map(mapCatalogRow);
  }

  public saveUpload(upload: StoredUpload): void {
    this.#database
      .prepare(
        `INSERT INTO uploads(
          job_id, local_id, source_revision, upload_url, edge_transfer_id,
          upload_id, upload_token, credential_expires_at,
          credential_refresh_after, chunk_bytes, offset_bytes,
          total_bytes, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET
          local_id = excluded.local_id,
          source_revision = excluded.source_revision,
          upload_url = excluded.upload_url,
          edge_transfer_id = excluded.edge_transfer_id,
          upload_id = excluded.upload_id,
          upload_token = excluded.upload_token,
          credential_expires_at = excluded.credential_expires_at,
          credential_refresh_after = excluded.credential_refresh_after,
          chunk_bytes = excluded.chunk_bytes,
          offset_bytes = excluded.offset_bytes,
          total_bytes = excluded.total_bytes,
          updated_at = excluded.updated_at`,
      )
      .run(
        upload.jobId,
        upload.localId,
        upload.sourceRevision,
        upload.uploadUrl,
        upload.edgeTransferId,
        upload.uploadId,
        upload.uploadToken,
        upload.credentialExpiresAt,
        upload.credentialRefreshAfter,
        upload.chunkBytes,
        upload.offset,
        upload.totalBytes,
        upload.updatedAt,
      );
  }

  public getUpload(jobId: string): StoredUpload | undefined {
    const row = this.#database
      .prepare("SELECT * FROM uploads WHERE job_id = ?")
      .get(jobId) as unknown as UploadRow | undefined;
    return row ? mapUploadRow(row) : undefined;
  }

  public deleteUpload(jobId: string): void {
    this.#database.prepare("DELETE FROM uploads WHERE job_id = ?").run(jobId);
  }

  public deleteUploadByTransferId(edgeTransferId: string): void {
    this.#database
      .prepare("DELETE FROM uploads WHERE edge_transfer_id = ?")
      .run(edgeTransferId);
  }

  public setMeta(key: string, value: string): void {
    this.#database
      .prepare(
        `INSERT INTO agent_meta(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  public getMeta(key: string): string | undefined {
    const row = this.#database
      .prepare("SELECT value FROM agent_meta WHERE key = ?")
      .get(key) as unknown as { readonly value: string } | undefined;
    return row?.value;
  }

  public deleteMeta(key: string): void {
    this.#database.prepare("DELETE FROM agent_meta WHERE key = ?").run(key);
  }

  public close(): void {
    this.#database.close();
  }

  public [Symbol.dispose](): void {
    this.close();
  }

  #transaction(operation: () => void): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      operation();
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}

function mapCatalogRow(row: CatalogRow): CatalogEntry {
  return {
    localId: row.local_id,
    relativePath: row.relative_path,
    displayName: row.display_name,
    bytes: row.bytes,
    mtimeMs: row.mtime_ms,
    revision: row.revision,
  };
}

function mapUploadRow(row: UploadRow): StoredUpload {
  return {
    jobId: row.job_id,
    localId: row.local_id,
    sourceRevision: row.source_revision,
    uploadUrl: row.upload_url,
    edgeTransferId: row.edge_transfer_id,
    uploadId: row.upload_id,
    uploadToken: row.upload_token,
    credentialExpiresAt: row.credential_expires_at,
    credentialRefreshAfter: row.credential_refresh_after,
    chunkBytes: row.chunk_bytes,
    offset: row.offset_bytes,
    totalBytes: row.total_bytes,
    updatedAt: row.updated_at,
  };
}
