import type { VodPhase } from "./vod-controller.js";

export function mediaErrorMessage(
  code: number | null,
  codec?: string | null,
): string {
  if (code === 1) return "节目加载已中止，可重新获取最新进度后重试";
  if (code === 2)
    return "节目网络请求失败，请检查连接；重新加载会重新验证访问权限";
  if (code === 3)
    return `当前设备解码失败${codec ? `（${codec}）` : ""}；服务器不会转码，请检查文件及设备支持`;
  if (code === 4)
    return "节目格式不受支持或媒体地址不可用，请检查文件状态及访问权限；服务器不会转码";
  return "节目暂不可用，请检查网络、访问权限和文件状态";
}

export function vodPhaseLabel(phase: VodPhase | undefined): string {
  switch (phase) {
    case "disabled":
      return "请点击启用节目声音";
    case "preparing":
      return "正在等待影片信息与同步时刻";
    case "seeking":
      return "正在同步到主持人的进度";
    case "buffering":
      return "正在缓冲目标位置";
    case "autoplay-blocked":
      return "需要点击后继续播放";
    case "error":
      return "同步未完成，请重试";
    case "paused":
      return "已暂停";
    case "playing":
      return "正在播放";
    default:
      return "正在准备";
  }
}
