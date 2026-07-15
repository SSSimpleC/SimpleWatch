import type { MediaItem } from "./api.js";

export function averageBitrateMbps(media: MediaItem | undefined): number {
  if (!media?.durationMs || media.durationMs <= 0) return 0;
  return (media.bytes * 8) / (media.durationMs / 1000) / 1_000_000;
}

export function isHighLoadVod(media: MediaItem | undefined): boolean {
  return Boolean(
    media &&
    (averageBitrateMbps(media) > 12 ||
      media.video.playbackSupport !== "broad" ||
      (media.video.width ?? 0) > 1920 ||
      (media.video.height ?? 0) > 1080),
  );
}
