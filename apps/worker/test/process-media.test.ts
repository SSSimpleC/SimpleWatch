import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  moveFile,
  processProbeJob,
  processSubtitleJob,
} from "../src/process-media.js";
import { probeFile } from "@simplewatch/media";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("processProbeJob", () => {
  it("hashes, probes, and atomically publishes a compatible MP4", async () => {
    const repositoryRoot = resolve(import.meta.dirname, "../../..");
    const temporaryDirectory = join(repositoryRoot, "tmp");
    mkdirSync(temporaryDirectory, { recursive: true });
    const root = mkdtempSync(join(temporaryDirectory, "worker-test-"));
    roots.push(root);
    const uploadRoot = join(root, "uploads");
    const mediaRoot = join(root, "media");
    const inboxRoot = join(root, "inbox");
    const subtitleRoot = join(root, "subtitles");
    mkdirSync(uploadRoot, { recursive: true });
    const source = join(uploadRoot, "sample.mp4");
    copyFileSync(
      join(repositoryRoot, "test-data/generated/media-smoke.mp4"),
      source,
    );

    const result = await processProbeJob(
      {
        uploadId: "upload-1",
        filePath: source,
        storageKey: "opaque-storage-key",
      },
      { uploadRoot, mediaRoot, inboxRoot, subtitleRoot },
    );

    expect(result.compatible).toBe(true);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.finalPath).toBe(
      resolve(mediaRoot, "opaque-storage-key/content.mp4"),
    );
    expect(existsSync(source)).toBe(false);
    expect(existsSync(result.finalPath)).toBe(true);
  });

  it("falls back to copy and unlink across filesystems", () => {
    const calls: string[] = [];
    let renameCount = 0;
    moveFile("/uploads/source", "/media/content.mp4", {
      rename: (source, destination) => {
        calls.push(`rename:${source}:${destination}`);
        if (renameCount++ === 0)
          throw Object.assign(new Error("cross-device move"), {
            code: "EXDEV",
          });
      },
      copy: (source, destination) =>
        calls.push(`copy:${source}:${destination}`),
      unlink: (path) => calls.push(`unlink:${path}`),
      remove: (path) => calls.push(`remove:${path}`),
    });

    expect(calls[0]).toBe("rename:/uploads/source:/media/content.mp4");
    expect(calls[1]).toMatch(
      /^copy:\/uploads\/source:\/media\/content\.mp4\..+\.tmp$/,
    );
    expect(calls[2]).toMatch(
      /^rename:\/media\/content\.mp4\..+\.tmp:\/media\/content\.mp4$/,
    );
    expect(calls[3]).toBe("unlink:/uploads/source");
  });

  it("accepts a registered SFTP inbox file as a probe source", async () => {
    const repositoryRoot = resolve(import.meta.dirname, "../../..");
    const root = mkdtempSync(resolve(repositoryRoot, "tmp/sftp-probe-test-"));
    roots.push(root);
    const uploadRoot = join(root, "uploads");
    const mediaRoot = join(root, "media");
    const inboxRoot = join(root, "inbox");
    const subtitleRoot = join(root, "subtitles");
    mkdirSync(join(inboxRoot, "sftp"), { recursive: true });
    const source = join(inboxRoot, "sftp", "sample.mp4");
    copyFileSync(
      join(repositoryRoot, "test-data/generated/media-smoke.mp4"),
      source,
    );

    const result = await processProbeJob(
      {
        filePath: source,
        storageKey: "sftp-storage-key",
        source: "sftp",
      },
      { uploadRoot, mediaRoot, inboxRoot, subtitleRoot },
    );

    expect(result.compatible).toBe(true);
    expect(result.finalPath).toBe(
      resolve(mediaRoot, "sftp-storage-key/content.mp4"),
    );
    expect(existsSync(source)).toBe(false);
  });

  it("copy-remuxes H.265 to hvc1 without transcoding", async () => {
    const repositoryRoot = resolve(import.meta.dirname, "../../..");
    const root = mkdtempSync(resolve(repositoryRoot, "tmp/hevc-worker-test-"));
    roots.push(root);
    const uploadRoot = join(root, "uploads");
    const mediaRoot = join(root, "media");
    const inboxRoot = join(root, "inbox");
    const subtitleRoot = join(root, "subtitles");
    mkdirSync(uploadRoot, { recursive: true });
    const source = join(uploadRoot, "hevc.mp4");
    copyFileSync(
      join(repositoryRoot, "test-data/generated/media-smoke-hevc-hev1.mp4"),
      source,
    );

    const result = await processProbeJob(
      {
        uploadId: "upload-hevc",
        filePath: source,
        storageKey: "hevc-storage-key",
      },
      { uploadRoot, mediaRoot, inboxRoot, subtitleRoot },
    );
    const verified = await probeFile(result.finalPath);

    expect(result.compatible).toBe(true);
    expect(verified.compatibility).toMatchObject({
      compatible: true,
      playbackSupport: "device-dependent",
      fastStart: true,
      video: { codec: "hevc", codecTag: "hvc1" },
    });
  });
});

describe("processSubtitleJob", () => {
  it("writes a bounded immutable WebVTT artifact", () => {
    const root = mkdtempSync(
      resolve(import.meta.dirname, "../../../tmp/subtitle-worker-test-"),
    );
    roots.push(root);
    const content = Buffer.from("WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n");
    const result = processSubtitleJob(
      {
        storageKey: "subtitle-storage-key",
        contentBase64: content.toString("base64"),
      },
      root,
    );
    expect(result.bytes).toBe(content.length);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(result.finalPath)).toBe(true);
    expect(() =>
      processSubtitleJob(
        {
          storageKey: "subtitle-storage-key",
          contentBase64: content.toString("base64"),
        },
        root,
      ),
    ).toThrow();
  });
});
