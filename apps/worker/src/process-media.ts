import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { moveFile, probeFile } from "@simplewatch/media";

const execFileAsync = promisify(execFile);

export interface ProbeJobPayload {
  readonly uploadId?: string | undefined;
  readonly filePath: string;
  readonly storageKey: string;
  readonly source?: "sftp" | undefined;
}

export interface MediaWorkerRoots {
  readonly uploadRoot: string;
  readonly mediaRoot: string;
  readonly inboxRoot: string;
  readonly subtitleRoot: string;
}

export async function processProbeJob(
  payload: ProbeJobPayload,
  roots: MediaWorkerRoots,
  ffprobePath = "ffprobe",
  ffmpegPath = "ffmpeg",
) {
  const sourceRoot =
    payload.source === "sftp" ? roots.inboxRoot : roots.uploadRoot;
  const storageKey = requireStorageKey(payload.storageKey);
  const requestedSource = requireLexicalPathWithin(
    payload.filePath,
    sourceRoot,
  );
  mkdirSync(roots.mediaRoot, { recursive: true });
  mkdirSync(roots.inboxRoot, { recursive: true });
  const publishedPath = join(roots.mediaRoot, storageKey, "content.mp4");
  if (existsSync(publishedPath)) {
    const recovered = requireExistingFileWithin(publishedPath, roots.mediaRoot);
    const inspected = await inspectProbeArtifact(recovered, ffprobePath);
    if (!inspected.compatibility.compatible) {
      throw new Error("最终媒体目录中的影片已不满足兼容性要求");
    }
    return inspected.result;
  }
  const inboxPath = join(
    roots.inboxRoot,
    storageKey,
    basename(requestedSource),
  );
  const source = existsSync(inboxPath)
    ? requireExistingFileWithin(inboxPath, roots.inboxRoot)
    : requireExistingFileWithin(requestedSource, sourceRoot);
  const before = statSync(source);
  if (!before.isFile()) throw new Error("上传结果不是普通文件");

  let { probe, compatibility } = await probeFile(source, ffprobePath);
  const destinationRoot = compatibility.compatible
    ? roots.mediaRoot
    : roots.inboxRoot;
  const destinationDirectory = join(destinationRoot, storageKey);
  mkdirSync(destinationDirectory, { recursive: true });
  const finalPath = join(
    destinationDirectory,
    compatibility.compatible ? "content.mp4" : basename(source),
  );
  const needsRemux =
    compatibility.compatible &&
    (!compatibility.fastStart ||
      !compatibility.container?.split(",").includes("mp4") ||
      (compatibility.video.codec === "hevc" &&
        compatibility.video.codecTag?.toLowerCase() !== "hvc1") ||
      compatibility.audio.codec !== "aac" ||
      (compatibility.audio.channels ?? 0) > 2);
  if (resolve(source) === resolve(finalPath)) {
    // 上次处理已完成文件移动，但结果响应可能在网络中丢失。保留现有
    // 安全路径并重新计算结果，使同一任务能够幂等提交。
  } else if (needsRemux) {
    const temporary = `${finalPath}.${randomUUID()}.remux.mp4`;
    try {
      await remuxForBrowser(source, temporary, compatibility, ffmpegPath);
      const verified = await probeFile(temporary, ffprobePath);
      if (
        !verified.compatibility.compatible ||
        !verified.compatibility.fastStart ||
        (verified.compatibility.video.codec === "hevc" &&
          verified.compatibility.video.codecTag?.toLowerCase() !== "hvc1")
      ) {
        throw new Error("重封装后的影片仍不满足浏览器直放要求");
      }
      probe = verified.probe;
      compatibility = verified.compatibility;
      renameSync(temporary, finalPath);
      unlinkSync(source);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  } else {
    moveFile(source, finalPath);
  }
  const finalStat = statSync(finalPath);
  const sha256 = await hashFile(finalPath);

  return {
    compatible: compatibility.compatible,
    probe,
    reasons: compatibility.reasons,
    sha256,
    bytes: finalStat.size,
    durationMs: compatibility.durationMs,
    finalPath: resolve(finalPath),
  };
}

export async function remuxForBrowser(
  source: string,
  destination: string,
  compatibility: {
    readonly video: { readonly codec: string | null };
    readonly audio: {
      readonly codec: string | null;
      readonly channels: number | null;
    };
  },
  ffmpegPath = "ffmpeg",
): Promise<void> {
  const args = [
    "-v",
    "error",
    "-y",
    "-i",
    source,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-c:v",
    "copy",
  ];
  if (
    compatibility.audio.codec === "aac" &&
    (compatibility.audio.channels ?? 0) <= 2
  )
    args.push("-c:a", "copy");
  else args.push("-c:a", "aac", "-ac", "2", "-ar", "48000");
  if (compatibility.video.codec === "hevc") args.push("-tag:v", "hvc1");
  args.push("-movflags", "+faststart", destination);
  await execFileAsync(ffmpegPath, args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
}

export function processSubtitleJob(
  payload: {
    readonly storageKey: string;
    readonly contentBase64: string;
  },
  subtitleRoot: string,
) {
  const content = Buffer.from(payload.contentBase64, "base64");
  if (content.length === 0 || content.length > 2 * 1024 * 1024) {
    throw new Error("字幕大小无效");
  }
  mkdirSync(subtitleRoot, { recursive: true });
  const storageKey = requireStorageKey(payload.storageKey);
  const finalPath = resolve(subtitleRoot, `${storageKey}.vtt`);
  if (existsSync(finalPath)) {
    const existing = readFileSync(
      requireExistingFileWithin(finalPath, subtitleRoot),
    );
    if (!existing.equals(content)) {
      throw new Error("字幕目标已存在但内容不一致");
    }
  } else {
    writeFileSync(finalPath, content, { flag: "wx" });
  }
  return {
    finalPath,
    bytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path))
    hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function inspectProbeArtifact(path: string, ffprobePath: string) {
  const { probe, compatibility } = await probeFile(path, ffprobePath);
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error("媒体结果不是普通文件");
  return {
    compatibility,
    result: {
      compatible: compatibility.compatible,
      probe,
      reasons: compatibility.reasons,
      sha256: await hashFile(path),
      bytes: stat.size,
      durationMs: compatibility.durationMs,
      finalPath: resolve(path),
    },
  };
}

function requireStorageKey(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error("媒体存储标识无效");
  }
  return value;
}

function requireExistingFileWithin(path: string, root: string): string {
  const lexical = requireLexicalPathWithin(path, root);
  let realRoot: string;
  let realPath: string;
  try {
    realRoot = realpathSync(root);
    realPath = realpathSync(lexical);
  } catch {
    throw new Error("媒体任务源文件不存在或不可访问");
  }
  if (realPath !== realRoot && !realPath.startsWith(`${realRoot}${sep}`)) {
    throw new Error("文件路径超出上传目录");
  }
  if (!statSync(realPath).isFile()) throw new Error("上传结果不是普通文件");
  return realPath;
}

function requireLexicalPathWithin(path: string, root: string): string {
  const absoluteRoot = resolve(root);
  const absolute = resolve(path);
  if (
    absolute !== absoluteRoot &&
    !absolute.startsWith(`${absoluteRoot}${sep}`)
  ) {
    throw new Error("文件路径超出上传目录");
  }
  return absolute;
}
