import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AgentState } from "../src/state.js";
import type { CatalogEntry, StoredUpload } from "../src/types.js";

const entry: CatalogEntry = {
  localId: "opaque-local-id",
  relativePath: "Series/Episode 01.mkv",
  displayName: "Episode 01.mkv",
  bytes: 1234,
  mtimeMs: 1_700_000_000_000,
  revision: "revision-one",
};

describe("Agent SQLite 状态", () => {
  it("只有连续两代观察相同size和mtime后才把文件标记为稳定", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simplewatch-state-"));
    using state = new AgentState(join(directory, "agent.sqlite3"));

    expect(state.observeCatalog(1, [entry])).toEqual([]);
    expect(state.observeCatalog(2, [entry])).toEqual([entry]);

    const changed = {
      ...entry,
      bytes: entry.bytes + 1,
      revision: "revision-two",
    };
    expect(state.observeCatalog(3, [changed])).toEqual([]);
    expect(state.observeCatalog(4, [changed])).toEqual([changed]);
  });

  it("持久保存catalog与tus断点，重启后可以继续", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simplewatch-state-"));
    const databasePath = join(directory, "agent.sqlite3");
    const upload: StoredUpload = {
      jobId: "job-id",
      localId: entry.localId,
      sourceRevision: entry.revision,
      uploadUrl: "https://example.test/files/upload-id",
      edgeTransferId: "transfer-id",
      uploadId: "upload-id",
      uploadToken: "secret-token-never-logged",
      credentialExpiresAt: 1_800_000_000_000,
      credentialRefreshAfter: 1_799_999_000_000,
      chunkBytes: 16 * 1024 * 1024,
      offset: 512,
      totalBytes: entry.bytes,
      updatedAt: 1_700_000_000_000,
    };
    {
      using state = new AgentState(databasePath);
      state.replaceCatalog(1, [entry]);
      state.saveUpload(upload);
    }
    using reopened = new AgentState(databasePath);

    expect(reopened.getCatalogItem(entry.localId)).toEqual(entry);
    expect(reopened.getUpload(upload.jobId)).toEqual(upload);
  });
});
