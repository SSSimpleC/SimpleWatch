import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRemuxArgs,
  processProbeJob,
  remuxForBrowser,
} from "../src/process-media.js";

const scratch: string[] = [];
const repositoryRoot = resolve(import.meta.dirname, "../../..");
afterEach(() => {
  for (const path of scratch.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function temporary() {
  mkdirSync(resolve(repositoryRoot, "tmp"), { recursive: true });
  const root = mkdtempSync(resolve(repositoryRoot, "tmp/no-transcode-"));
  scratch.push(root);
  return root;
}
function packetHashes(path: string) {
  const result = JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_packets",
        "-show_data_hash",
        "sha256",
        "-show_entries",
        "packet=stream_index,data_hash",
        "-of",
        "json",
        path,
      ],
      { encoding: "utf8" },
    ),
  ) as { packets: { stream_index: number; data_hash: string }[] };
  return result.packets;
}
describe("strict stream-copy publication", () => {
  it.each(["h264", "hevc"])(
    "never invokes any encoder or audio conversion for %s",
    (codec) => {
      const args = buildRemuxArgs("input", "output.mp4", { video: { codec } });
      expect(
        args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 2),
      ).toEqual(["-c:v", "copy"]);
      expect(
        args.slice(args.indexOf("-c:a"), args.indexOf("-c:a") + 2),
      ).toEqual(["-c:a", "copy"]);
      for (const forbidden of [
        "-ac",
        "-ar",
        "-af",
        "-vf",
        "-r",
        "libx264",
        "libx265",
        "aac",
      ])
        expect(args).not.toContain(forbidden);
    },
  );
  it("preserves every encoded audio and video packet while remuxing", async () => {
    const source = resolve(
      repositoryRoot,
      "test-data/generated/media-smoke.mp4",
    );
    const before = readFileSync(source);
    const output = join(temporary(), "copied.mp4");
    await remuxForBrowser(source, output, {
      video: { codec: "h264" },
      audio: { codec: "aac", channels: 2 },
    });
    const expected = packetHashes(source);
    expect(expected.some((packet) => packet.stream_index === 0)).toBe(true);
    expect(expected.some((packet) => packet.stream_index === 1)).toBe(true);
    expect(packetHashes(output)).toEqual(expected);
    expect(readFileSync(source)).toEqual(before);
  });
  it("keeps the complete input when remux fails and does not publish a partial result", async () => {
    const root = temporary();
    const uploadRoot = join(root, "uploads");
    mkdirSync(uploadRoot);
    const source = join(uploadRoot, "source.mp4");
    copyFileSync(
      resolve(repositoryRoot, "test-data/generated/media-smoke-hevc-hev1.mp4"),
      source,
    );
    const before = readFileSync(source);
    await expect(
      processProbeJob(
        { filePath: source, storageKey: "failed-copy" },
        {
          uploadRoot,
          mediaRoot: join(root, "media"),
          inboxRoot: join(root, "inbox"),
          subtitleRoot: join(root, "subtitles"),
        },
        "ffprobe",
        "/usr/bin/false",
      ),
    ).rejects.toThrow();
    expect(readFileSync(source)).toEqual(before);
    expect(existsSync(join(root, "media/failed-copy/content.mp4"))).toBe(false);
  });
});
