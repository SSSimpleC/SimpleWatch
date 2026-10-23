import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { playerBuildId } from "../vite.config.js";

let root: string;
beforeEach(() => {
  mkdirSync(resolve("tmp"), { recursive: true });
  root = mkdtempSync(join(resolve("tmp"), "player-build-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

describe("verified player build identity", () => {
  it("uses a verified candidate source hash without requiring Git", () => {
    const source = '{"name":"test"}';
    writeFileSync(join(root, "package.json"), source);
    const entries = [{ file: "package.json", sha256: digest(source) }];
    const sourceSha256 = digest(`${entries[0]!.sha256}  package.json\n`);
    writeFileSync(
      join(root, "source-manifest.json"),
      JSON.stringify({ sourceSha256, entries }),
    );
    expect(playerBuildId(root)).toBe(sourceSha256);
    writeFileSync(join(root, "package.json"), "changed");
    expect(() => playerBuildId(root)).toThrow(/does not match/);
  });

  it("fails closed for a mismatched manifest or non-source entry", () => {
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(
      join(root, "source-manifest.json"),
      JSON.stringify({
        sourceSha256: "a".repeat(64),
        entries: [{ file: "package.json", sha256: digest("{}") }],
      }),
    );
    expect(() => playerBuildId(root)).toThrow(/digest mismatch/);
    writeFileSync(
      join(root, "source-manifest.json"),
      JSON.stringify({
        sourceSha256: "a".repeat(64),
        entries: [{ file: ".env", sha256: "a".repeat(64) }],
      }),
    );
    expect(() => playerBuildId(root)).toThrow(/Invalid player source entry/);
  });

  it("produces deterministic local identity and ignores local credentials", () => {
    mkdirSync(join(root, "apps/web/src"), { recursive: true });
    writeFileSync(join(root, "apps/web/src/main.ts"), "version one");
    const first = playerBuildId(root);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(playerBuildId(root)).toBe(first);
    writeFileSync(join(root, ".env"), "SECRET=example");
    expect(playerBuildId(root)).toBe(first);
    writeFileSync(join(root, "apps/web/src/main.ts"), "version two");
    expect(playerBuildId(root)).not.toBe(first);
  });

  it("rejects manifest entries through a parent-directory symlink outside the candidate", () => {
    const candidate = join(root, "candidate");
    const external = join(root, "external");
    mkdirSync(join(candidate, "apps/web"), { recursive: true });
    mkdirSync(external);
    writeFileSync(join(external, "main.ts"), "outside");
    symlinkSync(external, join(candidate, "apps/web/src"));
    const entries = [
      { file: "apps/web/src/main.ts", sha256: digest("outside") },
    ];
    const sourceSha256 = digest(`${entries[0]!.sha256}  ${entries[0]!.file}\n`);
    writeFileSync(
      join(candidate, "source-manifest.json"),
      JSON.stringify({ sourceSha256, entries }),
    );
    expect(() => playerBuildId(candidate)).toThrow(/does not match/);
  });
});
