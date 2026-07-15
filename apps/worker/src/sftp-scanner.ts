import { lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";

import { v7 as uuidv7 } from "uuid";

import { moveFile, sanitizeDisplayName } from "@simplewatch/media";

interface Observation {
  readonly size: number;
  readonly mtimeMs: number;
  readonly observedAt: number;
}

export interface SftpImportCandidate {
  readonly filename: string;
  readonly filePath: string;
  readonly bytes: number;
}

export class SftpScanner {
  private readonly observations = new Map<string, Observation>();

  public constructor(
    private readonly incomingRoot: string,
    private readonly inboxRoot: string,
    private readonly now: () => number = Date.now,
  ) {
    mkdirSync(incomingRoot, { recursive: true });
    mkdirSync(this.sftpInboxRoot, { recursive: true });
  }

  private get sftpInboxRoot(): string {
    return join(this.inboxRoot, "sftp");
  }

  /**
   * Returns every SFTP-owned inbox file. The API import endpoint is idempotent
   * by source path, so this is also the crash/network recovery mechanism.
   */
  public pendingImports(): SftpImportCandidate[] {
    return readdirSync(this.sftpInboxRoot, { withFileTypes: true }).flatMap(
      (entry) => {
        if (!entry.isFile() || entry.isSymbolicLink()) return [];
        const filePath = requirePathWithin(
          join(this.sftpInboxRoot, entry.name),
          this.sftpInboxRoot,
        );
        const stat = lstatSync(filePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
          return [];
        const filename = entry.name.replace(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i,
          "",
        );
        return [{ filename, filePath, bytes: stat.size }];
      },
    );
  }

  public scan(): SftpImportCandidate[] {
    const imported: SftpImportCandidate[] = [];
    const currentPaths = new Set<string>();
    for (const entry of readdirSync(this.incomingRoot, {
      withFileTypes: true,
    })) {
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        entry.name.endsWith(".part")
      )
        continue;
      let filename: string;
      try {
        filename = sanitizeDisplayName(entry.name);
      } catch {
        continue;
      }
      const source = requirePathWithin(
        join(this.incomingRoot, entry.name),
        this.incomingRoot,
      );
      currentPaths.add(source);
      const stat = lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) continue;
      const previous = this.observations.get(source);
      if (
        !previous ||
        previous.size !== stat.size ||
        previous.mtimeMs !== stat.mtimeMs
      ) {
        this.observations.set(source, {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          observedAt: this.now(),
        });
        continue;
      }
      if (
        this.now() - previous.observedAt < 60_000 ||
        this.now() - stat.mtimeMs < 120_000
      ) {
        continue;
      }
      const destination = resolve(
        this.sftpInboxRoot,
        `${uuidv7()}-${basename(filename)}`,
      );
      moveFile(source, destination);
      this.observations.delete(source);
      imported.push({ filename, filePath: destination, bytes: stat.size });
    }
    for (const path of this.observations.keys()) {
      if (!currentPaths.has(path)) this.observations.delete(path);
    }
    return imported;
  }
}

function requirePathWithin(path: string, root: string): string {
  const realRoot = realpathSync(root);
  const absolute = realpathSync(path);
  if (absolute !== realRoot && !absolute.startsWith(`${realRoot}${sep}`)) {
    throw new Error("SFTP 路径超出 incoming 目录");
  }
  return absolute;
}
