import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

import type { AppDatabase } from "../database.js";

export async function clearLibraryData(
  database: AppDatabase,
  options: {
    readonly quarantine: string;
    readonly roots: readonly string[];
    readonly now?: () => number;
  },
): Promise<{ readonly movedEntries: number; readonly clearedAt: string }> {
  const quarantine = resolve(options.quarantine);
  mkdirSync(quarantine, { recursive: false });
  const moved: Array<{ source: string; destination: string }> = [];
  let databaseCleared = false;

  try {
    await database.backup(join(quarantine, "simplewatch.sqlite3"));
    for (const rootInput of options.roots) {
      const root = resolve(rootInput);
      if (!existsSync(root)) continue;
      const destinationRoot = join(quarantine, "files", basename(root));
      mkdirSync(destinationRoot, { recursive: true });
      for (const entry of readdirSync(root)) {
        const source = join(root, entry);
        const destination = join(destinationRoot, entry);
        renameSync(source, destination);
        moved.push({ source, destination });
      }
    }

    const now = (options.now ?? Date.now)();
    database.transaction(() => {
      database
        .prepare(
          "UPDATE admin_sessions SET revoked_at = ? WHERE revoked_at IS NULL",
        )
        .run(now);
      // Edge Agent 的登记与机器凭据属于部署身份，不随片库内容清理。
      // 其余 Edge/节目单账本必须先于 legacy media/uploads 删除，避免
      // 清理后留下指向已移除媒体的任务或缓存状态。
      database.prepare("DELETE FROM edge_eviction_jobs").run();
      database.prepare("DELETE FROM program_watch_ranges").run();
      database.prepare("DELETE FROM program_play_history").run();
      database.prepare("DELETE FROM program_queue_items").run();
      database.prepare("DELETE FROM program_queues").run();
      database.prepare("DELETE FROM edge_upload_credentials").run();
      database.prepare("DELETE FROM edge_cache_replicas").run();
      database.prepare("DELETE FROM edge_transfer_jobs").run();
      database.prepare("DELETE FROM edge_agent_tasks").run();
      database.prepare("DELETE FROM edge_catalog_scan_entries").run();
      database.prepare("DELETE FROM edge_catalog_scan_pages").run();
      database.prepare("DELETE FROM edge_catalog_scans").run();
      database
        .prepare("UPDATE edge_catalog_items SET current_version_id = NULL")
        .run();
      database.prepare("DELETE FROM edge_catalog_versions").run();
      database.prepare("DELETE FROM edge_catalog_items").run();
      database.prepare("DELETE FROM media_transport_sessions").run();
      database.prepare("DELETE FROM rtc_revocations").run();
      database.prepare("DELETE FROM token_jti").run();
      database.prepare("DELETE FROM room_commands").run();
      database.prepare("DELETE FROM room_sessions").run();
      database.prepare("DELETE FROM room_state").run();
      database.prepare("DELETE FROM room_members").run();
      database.prepare("DELETE FROM rooms").run();
      database.prepare("DELETE FROM service_outbox").run();
      database.prepare("DELETE FROM subtitles").run();
      database.prepare("DELETE FROM media_jobs").run();
      database.prepare("DELETE FROM uploads").run();
      database.prepare("DELETE FROM media").run();
      database.prepare("DELETE FROM audit_events").run();
    })();
    databaseCleared = true;
    database.pragma("wal_checkpoint(TRUNCATE)");
    const clearedAt = new Date(now).toISOString();
    writeFileSync(
      join(quarantine, "CLEAR_COMPLETE.json"),
      `${JSON.stringify(
        {
          clearedAt,
          movedEntries: moved.length,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    return { movedEntries: moved.length, clearedAt };
  } catch (error) {
    if (!databaseCleared) {
      for (const item of moved.reverse()) {
        renameSync(item.destination, item.source);
      }
    }
    throw error;
  }
}
