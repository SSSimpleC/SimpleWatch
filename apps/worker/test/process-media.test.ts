import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { processProbeJob, processSubtitleJob } from "../src/process-media.js";
import { moveFile, probeFile } from "@simplewatch/media";

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

  it("removes a copied destination when source unlink fails", () => {
    const calls: string[] = [];
    let renameCount = 0;

    expect(() =>
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
        unlink: (path) => {
          calls.push(`unlink:${path}`);
          throw Object.assign(new Error("source directory is not writable"), {
            code: "EACCES",
          });
        },
        remove: (path) => calls.push(`remove:${path}`),
      }),
    ).toThrow("source directory is not writable");

    expect(calls).toHaveLength(6);
    expect(calls[4]).toMatch(/^remove:\/media\/content\.mp4\..+\.tmp$/);
    expect(calls[5]).toBe("remove:/media/content.mp4");
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

  it("idempotently recovers when a high-attempt job already moved its final media", async () => {
    const repositoryRoot = resolve(import.meta.dirname, "../../..");
    const root = mkdtempSync(
      resolve(repositoryRoot, "tmp/final-recovery-test-"),
    );
    roots.push(root);
    const uploadRoot = join(root, "uploads");
    const mediaRoot = join(root, "media");
    const inboxRoot = join(root, "inbox");
    const subtitleRoot = join(root, "subtitles");
    mkdirSync(join(mediaRoot, "recovered-storage-key"), { recursive: true });
    mkdirSync(uploadRoot, { recursive: true });
    const finalPath = join(mediaRoot, "recovered-storage-key", "content.mp4");
    copyFileSync(
      join(repositoryRoot, "test-data/generated/media-smoke.mp4"),
      finalPath,
    );

    const result = await processProbeJob(
      {
        uploadId: "legacy-upload",
        filePath: join(uploadRoot, "source-that-was-already-moved.mp4"),
        storageKey: "recovered-storage-key",
      },
      { uploadRoot, mediaRoot, inboxRoot, subtitleRoot },
    );

    expect(result.compatible).toBe(true);
    expect(result.finalPath).toBe(resolve(finalPath));
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("recovers an already-moved inbox artifact without trusting the missing source path", async () => {
    const repositoryRoot = resolve(import.meta.dirname, "../../..");
    const root = mkdtempSync(
      resolve(repositoryRoot, "tmp/inbox-recovery-test-"),
    );
    roots.push(root);
    const uploadRoot = join(root, "uploads");
    const mediaRoot = join(root, "media");
    const inboxRoot = join(root, "inbox");
    const subtitleRoot = join(root, "subtitles");
    mkdirSync(join(inboxRoot, "inbox-recovery-key"), { recursive: true });
    mkdirSync(uploadRoot, { recursive: true });
    const recoveredSource = join(
      inboxRoot,
      "inbox-recovery-key",
      "missing-source.mp4",
    );
    copyFileSync(
      join(repositoryRoot, "test-data/generated/media-smoke.mp4"),
      recoveredSource,
    );

    const result = await processProbeJob(
      {
        filePath: join(uploadRoot, "missing-source.mp4"),
        storageKey: "inbox-recovery-key",
      },
      { uploadRoot, mediaRoot, inboxRoot, subtitleRoot },
    );

    expect(result.compatible).toBe(true);
    expect(result.finalPath).toBe(
      resolve(mediaRoot, "inbox-recovery-key/content.mp4"),
    );
    expect(existsSync(recoveredSource)).toBe(false);
  });

  it("rejects a source symlink that resolves outside the allowed upload root", async () => {
    const repositoryRoot = resolve(import.meta.dirname, "../../..");
    const root = mkdtempSync(resolve(repositoryRoot, "tmp/path-safety-test-"));
    roots.push(root);
    const uploadRoot = join(root, "uploads");
    const mediaRoot = join(root, "media");
    const inboxRoot = join(root, "inbox");
    const subtitleRoot = join(root, "subtitles");
    mkdirSync(uploadRoot, { recursive: true });
    const outside = join(root, "outside.mp4");
    copyFileSync(
      join(repositoryRoot, "test-data/generated/media-smoke.mp4"),
      outside,
    );
    const linkedSource = join(uploadRoot, "linked.mp4");
    symlinkSync(outside, linkedSource);

    await expect(
      processProbeJob(
        {
          filePath: linkedSource,
          storageKey: "outside-link-key",
        },
        { uploadRoot, mediaRoot, inboxRoot, subtitleRoot },
      ),
    ).rejects.toThrow("文件路径超出上传目录");
  });

  it("rejects an Edge source revision whose SHA-256 changed before ingest", async () => {
    const repositoryRoot = resolve(import.meta.dirname, "../../..");
    const root = mkdtempSync(resolve(repositoryRoot, "tmp/edge-sha-test-"));
    roots.push(root);
    const uploadRoot = join(root, "uploads");
    const mediaRoot = join(root, "media");
    const inboxRoot = join(root, "inbox");
    const subtitleRoot = join(root, "subtitles");
    mkdirSync(uploadRoot, { recursive: true });
    const source = join(uploadRoot, "changed.mp4");
    copyFileSync(
      join(repositoryRoot, "test-data/generated/media-smoke.mp4"),
      source,
    );

    await expect(
      processProbeJob(
        {
          filePath: source,
          storageKey: "changed-edge-source",
          expectedSourceSha256: "0".repeat(64),
          edgeJobId: "0197d0af-c352-7c19-91ed-069aa2785a55",
        },
        { uploadRoot, mediaRoot, inboxRoot, subtitleRoot },
      ),
    ).rejects.toThrow("上传源文件 SHA-256 与家庭目录版本不一致");
    expect(existsSync(source)).toBe(true);
    expect(existsSync(join(mediaRoot, "changed-edge-source"))).toBe(false);
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
    const sourceSha256 = hashFixture(source);

    const result = await processProbeJob(
      {
        uploadId: "upload-hevc",
        filePath: source,
        storageKey: "hevc-storage-key",
        expectedSourceSha256: sourceSha256,
        edgeJobId: "0197d0af-c352-7c19-91ed-069aa2785a55",
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
    expect(result.sourceSha256).toBe(sourceSha256);
    expect(result.sha256).not.toBe(sourceSha256);

    const recovered = await processProbeJob(
      {
        uploadId: "upload-hevc",
        filePath: source,
        storageKey: "hevc-storage-key",
        expectedSourceSha256: sourceSha256,
        edgeJobId: "0197d0af-c352-7c19-91ed-069aa2785a55",
      },
      { uploadRoot, mediaRoot, inboxRoot, subtitleRoot },
    );
    expect(recovered.sourceSha256).toBe(sourceSha256);
    expect(recovered.sha256).toBe(result.sha256);
  });
});

function hashFixture(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

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
    expect(
      processSubtitleJob(
        {
          storageKey: "subtitle-storage-key",
          contentBase64: content.toString("base64"),
        },
        root,
      ),
    ).toEqual(result);
  });
});
