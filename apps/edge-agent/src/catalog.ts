import { createHash } from "node:crypto";
import { opendir, lstat, realpath } from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import type { CatalogEntry, CatalogPagePayload } from "./types.js";

export const MAX_CATALOG_PAGE_BYTES = 512 * 1024;

const VIDEO_EXTENSIONS = new Set([
  ".3gp",
  ".avi",
  ".flv",
  ".m2ts",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".mts",
  ".ts",
  ".webm",
  ".wmv",
]);

export interface CatalogScan {
  readonly entries: readonly CatalogEntry[];
}

export async function scanLibrary(libraryRoot: string): Promise<CatalogScan> {
  const requestedRoot = resolve(libraryRoot);
  const requestedRootStats = await lstat(requestedRoot);
  if (requestedRootStats.isSymbolicLink()) {
    throw new Error("LIBRARY_ROOT 不能是符号链接");
  }
  const canonicalRoot = await realpath(requestedRoot);
  const rootStats = await lstat(canonicalRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("LIBRARY_ROOT 必须是普通目录，不能是符号链接");
  }

  const entries: CatalogEntry[] = [];
  await walkDirectory(canonicalRoot, canonicalRoot, entries);
  entries.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, "zh-CN", {
      numeric: true,
      sensitivity: "base",
    }),
  );
  return { entries };
}

export async function inspectCatalogFile(
  libraryRoot: string,
  relativePath: string,
): Promise<CatalogEntry> {
  if (!relativePath || isAbsolute(relativePath)) {
    throw new Error("媒体相对路径无效");
  }
  const canonicalRoot = await realpath(resolve(libraryRoot));
  const candidate = resolve(canonicalRoot, relativePath);
  const stats = await lstat(candidate);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("媒体源不是普通文件");
  }
  const canonicalFile = await realpath(candidate);
  if (!isPathWithinRoot(canonicalRoot, canonicalFile)) {
    throw new Error("媒体源越过了 Library 边界");
  }
  if (!VIDEO_EXTENSIONS.has(extname(canonicalFile).toLowerCase())) {
    throw new Error("媒体源扩展名不在白名单中");
  }
  return toCatalogEntry(
    canonicalRoot,
    canonicalFile,
    stats.size,
    stats.mtimeMs,
  );
}

export function isPathWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
  );
}

export function paginateCatalog(
  scanId: string,
  generation: number,
  entries: readonly CatalogEntry[],
  maximumBytes = MAX_CATALOG_PAGE_BYTES,
): CatalogPagePayload[] {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error("Catalog 分页上限无效");
  }
  const pages: CatalogPagePayload[] = [];
  let current: CatalogEntry[] = [];

  for (const entry of entries) {
    const candidate = makePage(scanId, generation, pages.length, [
      ...current,
      entry,
    ]);
    if (
      candidate.entries.length <= 2000 &&
      encodedBytes(candidate) <= maximumBytes
    ) {
      current.push(entry);
      continue;
    }
    if (current.length === 0) {
      throw new Error(`Catalog 条目超过单页上限：${entry.relativePath}`);
    }
    pages.push(makePage(scanId, generation, pages.length, current));
    current = [entry];
    const single = makePage(scanId, generation, pages.length, current);
    if (encodedBytes(single) > maximumBytes) {
      throw new Error(`Catalog 条目超过单页上限：${entry.relativePath}`);
    }
  }

  if (current.length > 0 || pages.length === 0) {
    pages.push(makePage(scanId, generation, pages.length, current));
  }
  return pages;
}

export function encodedBytes(payload: CatalogPagePayload): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

async function walkDirectory(
  canonicalRoot: string,
  directory: string,
  output: CatalogEntry[],
): Promise<void> {
  const handle = await opendir(directory);
  for await (const item of handle) {
    if (item.name.startsWith(".")) continue;
    const candidate = join(directory, item.name);
    const stats = await lstat(candidate);
    if (stats.isSymbolicLink()) continue;

    if (stats.isDirectory()) {
      const canonicalDirectory = await realpath(candidate);
      if (isPathWithinRoot(canonicalRoot, canonicalDirectory)) {
        await walkDirectory(canonicalRoot, canonicalDirectory, output);
      }
      continue;
    }

    if (!stats.isFile()) continue;
    if (!VIDEO_EXTENSIONS.has(extname(item.name).toLowerCase())) continue;
    const canonicalFile = await realpath(candidate);
    if (!isPathWithinRoot(canonicalRoot, canonicalFile)) continue;
    output.push(
      toCatalogEntry(canonicalRoot, canonicalFile, stats.size, stats.mtimeMs),
    );
  }
}

function toCatalogEntry(
  canonicalRoot: string,
  canonicalFile: string,
  bytes: number,
  modifiedAtMs: number,
): CatalogEntry {
  const relativePath = relative(canonicalRoot, canonicalFile);
  const localId = digest(`path\0${relativePath}`);
  const normalizedModifiedAtMs = Math.trunc(modifiedAtMs);
  return {
    localId,
    relativePath,
    displayName: basename(canonicalFile),
    bytes,
    mtimeMs: normalizedModifiedAtMs,
    revision: digest(
      `revision\0${localId}\0${bytes}\0${normalizedModifiedAtMs}`,
    ),
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function makePage(
  scanId: string,
  generation: number,
  pageIndex: number,
  entries: readonly CatalogEntry[],
): CatalogPagePayload {
  return {
    scanId,
    generation,
    pageIndex,
    entries: entries.map((entry) => ({
      localId: entry.localId,
      relativePath: entry.relativePath,
      displayName: entry.displayName,
      bytes: entry.bytes,
      mtimeMs: entry.mtimeMs,
    })),
  };
}
