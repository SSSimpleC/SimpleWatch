import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  encodedBytes,
  inspectCatalogFile,
  isPathWithinRoot,
  MAX_CATALOG_PAGE_BYTES,
  paginateCatalog,
  scanLibrary,
} from "../src/catalog.js";

describe("家庭媒体目录索引", () => {
  it("只索引边界内的普通白名单视频并拒绝符号链接", async () => {
    const root = await mkdtemp(join(tmpdir(), "simplewatch-library-"));
    const outside = await mkdtemp(join(tmpdir(), "simplewatch-outside-"));
    await mkdir(join(root, "Series", "Season 1"), { recursive: true });
    await writeFile(
      join(root, "Series", "Season 1", "Episode 01.mkv"),
      "video",
    );
    await writeFile(join(root, "notes.txt"), "not-media");
    await writeFile(join(root, ".copying.mp4"), "not-yet-visible");
    await writeFile(join(outside, "outside.mp4"), "outside");
    await symlink(join(outside, "outside.mp4"), join(root, "escaped.mp4"));
    await symlink(outside, join(root, "escaped-directory"));

    const scan = await scanLibrary(root);

    expect(scan.entries).toHaveLength(1);
    expect(scan.entries[0]).toMatchObject({
      relativePath: "Series/Season 1/Episode 01.mkv",
      displayName: "Episode 01.mkv",
      bytes: 5,
    });
    expect(scan.entries[0]?.localId).not.toContain("Series");
    expect(isPathWithinRoot(root, join(outside, "outside.mp4"))).toBe(false);
    await expect(inspectCatalogFile(root, "../outside.mp4")).rejects.toThrow();
    await expect(inspectCatalogFile(root, "escaped.mp4")).rejects.toThrow();
    const rootLink = join(
      await mkdtemp(join(tmpdir(), "simplewatch-link-")),
      "library",
    );
    await symlink(root, rootLink);
    await expect(scanLibrary(rootLink)).rejects.toThrow("不能是符号链接");
  });

  it("生成不超过512KiB且每页最多2000项的确定性分页", () => {
    const entries = Array.from({ length: 4_101 }, (_, index) => ({
      localId: `local-${index}`,
      relativePath: `Series/Episode-${String(index).padStart(5, "0")}.mkv`,
      displayName: `Episode-${index}.mkv`,
      bytes: index,
      mtimeMs: 1_700_000_000_000 + index,
      revision: `revision-${index}`,
    }));

    const pages = paginateCatalog("scan-id", 7, entries);

    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(pages.every((page) => page.entries.length <= 2_000)).toBe(true);
    expect(
      pages.every((page) => encodedBytes(page) <= MAX_CATALOG_PAGE_BYTES),
    ).toBe(true);
    expect(
      pages.flatMap((page) => page.entries).map((entry) => entry.localId),
    ).toEqual(entries.map((entry) => entry.localId));
    expect(JSON.stringify(pages)).not.toContain("revision-");
  });
});
