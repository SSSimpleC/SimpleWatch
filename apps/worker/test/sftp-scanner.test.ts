import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SftpScanner } from "../src/sftp-scanner.js";

const roots: string[] = [];
const testTempRoot = fileURLToPath(new URL("../../../tmp/", import.meta.url));

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("SftpScanner", () => {
  it("requires two stable observations and ignores .part files", () => {
    mkdirSync(testTempRoot, { recursive: true });
    const root = mkdtempSync(resolve(testTempRoot, "sftp-scanner-test-"));
    roots.push(root);
    const incoming = join(root, "incoming");
    const inbox = join(root, "inbox");
    mkdirSync(incoming, { recursive: true });
    let now = 1_000_000;
    const completePath = join(incoming, "movie.mp4");
    const partialPath = join(incoming, "movie-2.mp4.part");
    writeFileSync(completePath, "complete");
    writeFileSync(partialPath, "partial");
    const old = new Date(now - 121_000);
    utimesSync(completePath, old, old);
    utimesSync(partialPath, old, old);
    const scanner = new SftpScanner(incoming, inbox, () => now);

    expect(scanner.scan()).toEqual([]);
    now += 60_001;
    const imported = scanner.scan();

    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({ filename: "movie.mp4", bytes: 8 });
    expect(existsSync(completePath)).toBe(false);
    expect(existsSync(imported[0]?.filePath ?? "")).toBe(true);
    expect(existsSync(partialPath)).toBe(true);
  });
});
