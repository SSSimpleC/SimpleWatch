import { rmSync } from "node:fs";
import { join } from "node:path";

import type { AppDatabase } from "../database.js";

type TerminalTransferState =
  | "blocked_storage"
  | "source_missing"
  | "source_changed"
  | "permission_denied"
  | "cancelled"
  | "failed";

export class EdgeTransferLifecycleService {
  public constructor(
    private readonly database: AppDatabase,
    private readonly uploadRoot: string,
  ) {}

  public finalize(
    edgeTransferId: string,
    state: TerminalTransferState,
    errorCode: string | null,
    errorMessage: string | null,
    timestamp: number,
  ): void {
    const upload = this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE edge_upload_credentials
           SET revoked_at = COALESCE(revoked_at, ?)
           WHERE edge_job_id = ?`,
        )
        .run(timestamp, edgeTransferId);
      const row = this.database
        .prepare("SELECT id FROM uploads WHERE edge_job_id = ?")
        .get(edgeTransferId) as { readonly id: string } | undefined;
      if (row) {
        this.database
          .prepare(
            `UPDATE uploads SET state = ?, error_code = ?, finished_at = ?
             WHERE id = ? AND state IN ('authorized', 'uploading', 'received')`,
          )
          .run(
            state === "cancelled" ? "cancelled" : "failed",
            errorCode,
            timestamp,
            row.id,
          );
      }
      return row;
    })();

    if (upload) {
      rmSync(join(this.uploadRoot, upload.id), { force: true });
      rmSync(join(this.uploadRoot, `${upload.id}.info`), { force: true });
    }

    this.database.transaction(() => {
      if (upload) {
        this.database
          .prepare("UPDATE uploads SET reserved_bytes = 0 WHERE id = ?")
          .run(upload.id);
      }
      this.database
        .prepare(
          `UPDATE edge_transfer_jobs
           SET state = ?, error_code = ?, error_message = ?,
               updated_at = ?, finished_at = ?
           WHERE id = ? AND state NOT IN ('ready', 'incompatible', 'evicted')`,
        )
        .run(
          state,
          errorCode,
          errorMessage,
          timestamp,
          timestamp,
          edgeTransferId,
        );
      this.database
        .prepare(
          `UPDATE program_queue_items
           SET preparation_state = ?, updated_at = ?
           WHERE transfer_job_id = ? AND preparation_state != 'ready'`,
        )
        .run(
          state === "blocked_storage" ? "blocked" : "failed",
          timestamp,
          edgeTransferId,
        );
    })();
  }
}
