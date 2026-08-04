import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { resolve } from "node:path";

import type { SourceProof } from "./api-client.js";
import { inspectCatalogFile } from "./catalog.js";
import type { CatalogEntry, SourceIdentity } from "./types.js";

export async function proveSource(
  libraryRoot: string,
  entry: CatalogEntry,
  expected: SourceIdentity,
  signal?: AbortSignal,
): Promise<SourceProof> {
  const before = await inspectCatalogFile(libraryRoot, entry.relativePath);
  assertExpected(before, expected);
  const hash = createHash("sha256");
  const stream = createReadStream(resolve(libraryRoot, entry.relativePath));
  const abort = () => stream.destroy(signal?.reason as Error | undefined);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of stream) {
      if (signal?.aborted) throw signal.reason;
      hash.update(chunk as Buffer);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  const after = await inspectCatalogFile(libraryRoot, entry.relativePath);
  if (before.revision !== after.revision) {
    throw new SourceProofError("SOURCE_CHANGED", "媒体源在校验过程中发生变化");
  }
  const sha256 = hash.digest("hex");
  if (expected.expectedSha256 && expected.expectedSha256 !== sha256) {
    throw new SourceProofError("SOURCE_CHANGED", "媒体源摘要与云端版本不一致");
  }
  return { bytes: after.bytes, mtimeMs: after.mtimeMs, sha256 };
}

export function assertExpected(
  entry: CatalogEntry,
  expected: SourceIdentity,
): void {
  if (
    entry.localId !== expected.localId ||
    entry.bytes !== expected.expectedBytes ||
    entry.mtimeMs !== expected.expectedMtimeMs
  ) {
    throw new SourceProofError("SOURCE_CHANGED", "媒体源版本已发生变化");
  }
}

export class SourceProofError extends Error {
  public constructor(
    public readonly code:
      | "SOURCE_MISSING"
      | "SOURCE_CHANGED"
      | "PERMISSION_DENIED",
    message: string,
  ) {
    super(message);
    this.name = "SourceProofError";
  }
}
