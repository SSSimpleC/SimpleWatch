import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { probeFile } from "../src/index.js";

import { execFileSync } from "node:child_process";

const outputDirectory = resolve("../../test-data/generated");
const outputPath = resolve(outputDirectory, "media-smoke.mp4");
const hevcOutputPath = resolve(outputDirectory, "media-smoke-hevc-hev1.mp4");
mkdirSync(outputDirectory, { recursive: true });
rmSync(outputPath, { force: true });
rmSync(hevcOutputPath, { force: true });

execFileSync(
  "ffmpeg",
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=30:duration=2",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=2",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=880:sample_rate=48000:duration=2",
    "-filter_complex",
    "[1:a][2:a]amerge=inputs=2[a]",
    "-map",
    "0:v",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    "high",
    "-level",
    "4.1",
    "-c:a",
    "aac",
    "-ac",
    "2",
    "-ar",
    "48000",
    "-movflags",
    "+faststart",
    "-y",
    outputPath,
  ],
  { stdio: "inherit", windowsHide: true },
);

execFileSync(
  "ffmpeg",
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=24:duration=1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=880:sample_rate=48000:duration=1",
    "-filter_complex",
    "[1:a][2:a]amerge=inputs=2[a]",
    "-map",
    "0:v",
    "-map",
    "[a]",
    "-c:v",
    "libx265",
    "-preset",
    "ultrafast",
    "-x265-params",
    "log-level=error:pools=1:frame-threads=1",
    "-pix_fmt",
    "yuv420p",
    "-tag:v",
    "hev1",
    "-c:a",
    "aac",
    "-ac",
    "2",
    "-ar",
    "48000",
    "-movflags",
    "+faststart",
    "-y",
    hevcOutputPath,
  ],
  { stdio: "inherit", windowsHide: true },
);

const result = await probeFile(outputPath);
const hevcResult = await probeFile(hevcOutputPath);
if (!result.compatibility.compatible) {
  throw new Error(
    `生成的媒体样片不兼容：${result.compatibility.reasons.join("；")}`,
  );
}
if (
  !hevcResult.compatibility.compatible ||
  hevcResult.compatibility.playbackSupport !== "device-dependent" ||
  hevcResult.compatibility.video.codec !== "hevc"
) {
  throw new Error(
    `生成的 H.265 样片不兼容：${hevcResult.compatibility.reasons.join("；")}`,
  );
}
console.log(
  JSON.stringify(
    {
      h264: { outputPath, compatibility: result.compatibility },
      hevc: {
        outputPath: hevcOutputPath,
        compatibility: hevcResult.compatibility,
      },
    },
    null,
    2,
  ),
);
