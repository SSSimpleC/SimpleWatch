import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type AppDatabase } from "../src/database.js";

let database: AppDatabase;

beforeEach(() => {
  database = openDatabase({
    databasePath: ":memory:",
    migrationsPath: "migrations",
    now: () => 1_750_000_000_000,
  });
});

afterEach(() => {
  database.close();
});

describe("Edge and program queue migrations", () => {
  it("applies 010-012 while preserving legacy insert shapes", () => {
    const migrations = database
      .prepare(
        "SELECT version FROM schema_migrations WHERE version IN ('010', '011', '012') ORDER BY version",
      )
      .all() as Array<{ version: string }>;

    database
      .prepare(
        `INSERT INTO admin_users(
          id, username, password_hash, created_at, password_changed_at
        ) VALUES ('admin', 'admin', 'hash', 1, 1)`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO media(
          id, storage_key, display_name, state, bytes, created_at
        ) VALUES ('legacy-media', 'legacy/key', 'Legacy', 'published', 1, 1)`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO rooms(
          id, password_hash, status, max_members, created_by, created_at
        ) VALUES ('legacy-room', 'hash', 'active', 5, 'admin', 1)`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO room_members(
          member_id, room_id, nickname, nickname_folded, role,
          joined_at, last_seen_at
        ) VALUES ('legacy-host', 'legacy-room', 'Host', 'host', 'host', 1, 1)`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO room_state(
          room_id, revision, mode, media_id, live_path,
          transport_json, host_member_id, updated_at
        ) VALUES ('legacy-room', 0, 'vod', 'legacy-media', NULL,
          NULL, 'legacy-host', 1)`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO uploads(
          id, owner_admin_id, state, declared_bytes, reserved_bytes,
          received_bytes, source, expires_at, created_at
        ) VALUES ('legacy-upload', 'admin', 'authorized', 1, 2,
          0, 'browser', 100, 1)`,
      )
      .run();

    const roomState = database
      .prepare(
        `SELECT program_queue_id, current_program_item_id
         FROM room_state WHERE room_id = 'legacy-room'`,
      )
      .get();
    const upload = database
      .prepare("SELECT edge_job_id FROM uploads WHERE id = 'legacy-upload'")
      .get();

    expect(migrations).toEqual([
      { version: "010" },
      { version: "011" },
      { version: "012" },
    ]);
    expect(roomState).toEqual({
      program_queue_id: null,
      current_program_item_id: null,
    });
    expect(upload).toEqual({ edge_job_id: null });
  });

  it("sets new references to null when legacy media or transfers are deleted", () => {
    seedEdgeReferences(database);

    database
      .prepare("DELETE FROM edge_transfer_jobs WHERE id = 'transfer'")
      .run();

    expect(
      database
        .prepare(
          `SELECT transfer_job_id FROM edge_cache_replicas
           WHERE id = 'replica'`,
        )
        .get(),
    ).toEqual({ transfer_job_id: null });
    expect(
      database
        .prepare("SELECT edge_job_id FROM uploads WHERE id = 'upload'")
        .get(),
    ).toEqual({ edge_job_id: null });
    expect(
      database
        .prepare(
          `SELECT transfer_job_id FROM program_queue_items
           WHERE id = 'program-item'`,
        )
        .get(),
    ).toEqual({ transfer_job_id: null });

    database.prepare("DELETE FROM media WHERE id = 'media'").run();

    expect(
      database
        .prepare(
          "SELECT media_id FROM edge_cache_replicas WHERE id = 'replica'",
        )
        .get(),
    ).toEqual({ media_id: null });
    expect(
      database
        .prepare(
          "SELECT media_id FROM program_queue_items WHERE id = 'program-item'",
        )
        .get(),
    ).toEqual({ media_id: null });
    expect(
      database
        .prepare(
          "SELECT media_id FROM program_play_history WHERE id = 'history'",
        )
        .get(),
    ).toEqual({ media_id: null });
  });

  it("stores cache compare-and-swap generation and row version", () => {
    seedEdgeReferences(database);

    expect(
      database
        .prepare(
          `SELECT generation, row_version, pinned
           FROM edge_cache_replicas WHERE id = 'replica'`,
        )
        .get(),
    ).toEqual({ generation: 3, row_version: 7, pinned: 0 });
  });

  it("persists a 48-hour retry deadline and uses a high attempt safety cap", () => {
    const columns = database
      .prepare("PRAGMA table_info(edge_agent_tasks)")
      .all() as Array<{
      readonly name: string;
      readonly notnull: number;
      readonly dflt_value: string | null;
    }>;
    expect(
      columns.find((column) => column.name === "retry_expires_at"),
    ).toMatchObject({ notnull: 1 });
    expect(
      columns.find((column) => column.name === "max_attempts"),
    ).toMatchObject({ dflt_value: "1024" });
  });

  it("records empty catalog pages and rejects conflicting page or path replay", () => {
    database
      .prepare(
        `INSERT INTO edge_agents(
          id, display_name, protocol_version, software_version,
          created_at, updated_at
        ) VALUES ('agent', 'Home', 1, '1.0.0', 1, 1)`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO edge_catalog_scans(
          id, agent_id, generation, state, started_at, updated_at
        ) VALUES ('scan', 'agent', 1, 'collecting', 1, 1)`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO edge_catalog_scan_pages(
          scan_id, page_index, payload_sha256, entry_count, received_at
        ) VALUES ('scan', 0, ?, 0, 1)`,
      )
      .run("a".repeat(64));

    expect(
      database
        .prepare(
          `SELECT page_index, entry_count
           FROM edge_catalog_scan_pages WHERE scan_id = 'scan'`,
        )
        .all(),
    ).toEqual([{ page_index: 0, entry_count: 0 }]);
    expect(() =>
      database
        .prepare(
          `INSERT INTO edge_catalog_scan_pages(
            scan_id, page_index, payload_sha256, entry_count, received_at
          ) VALUES ('scan', 0, ?, 0, 2)`,
        )
        .run("b".repeat(64)),
    ).toThrow();

    const insertEntry = database.prepare(
      `INSERT INTO edge_catalog_scan_entries(
        scan_id, local_id, relative_path, display_name, bytes, mtime_ms, page_index
      ) VALUES ('scan', ?, 'Series/01.mkv', '01.mkv', 1, 1, 0)`,
    );
    insertEntry.run("local-1");
    expect(() => insertEntry.run("local-2")).toThrow();
  });
});

function seedEdgeReferences(target: AppDatabase): void {
  target
    .prepare(
      `INSERT INTO admin_users(
        id, username, password_hash, created_at, password_changed_at
      ) VALUES ('admin', 'admin', 'hash', 1, 1)`,
    )
    .run();
  target
    .prepare(
      `INSERT INTO accounts(
        id, username, username_folded, role, password_hash,
        enabled, created_at, password_changed_at
      ) VALUES ('account', 'Host', 'host', 'host', 'hash', 1, 1, 1)`,
    )
    .run();
  target
    .prepare(
      `INSERT INTO edge_agents(
        id, display_name, protocol_version, software_version,
        created_at, updated_at
      ) VALUES ('agent', 'Home', 1, '1.0.0', 1, 1)`,
    )
    .run();
  target
    .prepare(
      `INSERT INTO edge_catalog_items(
        id, agent_id, local_id, relative_path, display_name, source_state,
        first_seen_at, last_seen_at, created_at, updated_at
      ) VALUES ('catalog-item', 'agent', 'local', 'Series/01.mkv', '01.mkv',
        'present', 1, 1, 1, 1)`,
    )
    .run();
  target
    .prepare(
      `INSERT INTO edge_catalog_versions(
        id, catalog_item_id, version_number, bytes, mtime_ms,
        source_state, first_seen_at, created_at
      ) VALUES ('catalog-version', 'catalog-item', 1, 100, 1,
        'present', 1, 1)`,
    )
    .run();
  target
    .prepare(
      `INSERT INTO media(
        id, storage_key, display_name, state, bytes, created_at
      ) VALUES ('media', 'edge/media', '01.mkv', 'published', 100, 1)`,
    )
    .run();
  target
    .prepare(
      `INSERT INTO edge_transfer_jobs(
        id, agent_id, catalog_version_id, owner_account_id, state,
        declared_bytes, media_id, created_at, updated_at
      ) VALUES ('transfer', 'agent', 'catalog-version', 'account', 'ready',
        100, 'media', 1, 1)`,
    )
    .run();
  target
    .prepare(
      `INSERT INTO uploads(
        id, owner_admin_id, state, declared_bytes, reserved_bytes,
        source, expires_at, created_at, edge_job_id
      ) VALUES ('upload', 'admin', 'received', 100, 100,
        'edge', 100, 1, 'transfer')`,
    )
    .run();
  target
    .prepare(
      "UPDATE edge_transfer_jobs SET upload_id = 'upload' WHERE id = 'transfer'",
    )
    .run();
  target
    .prepare(
      `INSERT INTO edge_cache_replicas(
        id, agent_id, catalog_version_id, transfer_job_id, media_id,
        state, generation, row_version, created_at, updated_at
      ) VALUES ('replica', 'agent', 'catalog-version', 'transfer', 'media',
        'ready', 3, 7, 1, 1)`,
    )
    .run();
  target
    .prepare(
      `INSERT INTO program_queues(
        id, owner_account_id, display_name, state, created_at, updated_at
      ) VALUES ('queue', 'account', 'Series', 'active', 1, 1)`,
    )
    .run();
  target
    .prepare(
      `INSERT INTO program_queue_items(
        id, queue_id, catalog_version_id, transfer_job_id, media_id,
        display_name, position, preparation_state, playback_state,
        created_at, updated_at
      ) VALUES ('program-item', 'queue', 'catalog-version', 'transfer', 'media',
        '01.mkv', 0, 'ready', 'current', 1, 1)`,
    )
    .run();
  target
    .prepare(
      `INSERT INTO program_play_history(
        id, queue_id, program_item_id, media_id, display_name,
        activation_sequence, activated_at
      ) VALUES ('history', 'queue', 'program-item', 'media', '01.mkv', 1, 1)`,
    )
    .run();
}
