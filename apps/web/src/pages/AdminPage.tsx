import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as tus from "tus-js-client";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import {
  api,
  ApiError,
  type ActiveRoomSummary,
  type MediaItem,
} from "../api.js";
import { useSession } from "../store.js";

interface UploadProgress {
  id: string;
  filename: string;
  uploaded: number;
  total: number;
  bytesPerSecond: number;
  state: "uploading" | "cancelling" | "processing" | "cancelled" | "failed";
  message?: string;
}

export function AdminPage() {
  const { adminCsrf, setAdminCsrf, setRoomCsrf, setMemberId } = useSession();
  const [message, setMessage] = useState("");
  const [selectedMedia, setSelectedMedia] = useState<string[]>([]);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(
    null,
  );
  const uploadRef = useRef<tus.Upload | null>(null);
  const speedRef = useRef({ at: 0, bytes: 0, smoothed: 0 });
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  useEffect(() => {
    if (adminCsrf) return;
    void api<{
      account: { role: "host" | "viewer" };
      csrfToken: string;
    }>("/api/v1/auth/session")
      .then((session) => {
        if (session.account.role !== "host") {
          void navigate("/", { replace: true });
          return;
        }
        setAdminCsrf(session.csrfToken);
      })
      .catch(() => void navigate("/", { replace: true }));
  }, [adminCsrf, navigate, setAdminCsrf]);

  const media = useQuery({
    queryKey: ["media"],
    queryFn: () => api<MediaItem[]>("/api/v1/media"),
    enabled: Boolean(adminCsrf),
    refetchInterval: 3000,
  });
  const activeRoom = useQuery({
    queryKey: ["admin-active-room"],
    queryFn: () => api<ActiveRoomSummary | null>("/api/v1/admin/active-room"),
    enabled: Boolean(adminCsrf),
    refetchInterval: 2000,
  });

  async function createRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!adminCsrf) return;
    try {
      const result = await api<{
        room: { id: string };
        member: { id: string };
        csrfToken: string;
      }>("/api/v1/rooms", {
        method: "POST",
        headers: { "x-csrf-token": adminCsrf },
        body: "{}",
      });
      setRoomCsrf(result.csrfToken);
      setMemberId(result.member.id);
      setMessage("放映室已开放，已登录好友会自动入场");
      await queryClient.invalidateQueries({ queryKey: ["admin-active-room"] });
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : "无法开启放映室");
    }
  }

  async function enterHostRoom() {
    if (!adminCsrf || !activeRoom.data) return;
    try {
      const result = await api<{
        state: "room";
        roomId: string;
        memberId: string;
      }>("/api/v1/room/takeover", {
        method: "POST",
        body: "{}",
      });
      setRoomCsrf(adminCsrf);
      setMemberId(result.memberId);
      void navigate(`/room/${result.roomId}`);
    } catch (error) {
      setMessage(
        error instanceof ApiError ? error.message : "无法进入主持房间",
      );
    }
  }

  async function forceCloseRoom() {
    if (!adminCsrf || !activeRoom.data) return;
    if (!confirm("强制关闭后，房间内所有人会立即断开。确定继续吗？")) return;
    try {
      await api("/api/v1/admin/active-room", {
        method: "DELETE",
        headers: { "x-csrf-token": adminCsrf },
      });
      setRoomCsrf(null);
      setMemberId(null);
      setMessage("房间已强制关闭，所有成员凭据均已撤销");
      await queryClient.invalidateQueries({ queryKey: ["admin-active-room"] });
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : "强制关闭失败");
    }
  }

  async function uploadFile(file: File) {
    if (!adminCsrf || uploadProgress?.state === "uploading") return;
    setMessage("");
    let auth: {
      uploadId: string;
      tusEndpoint: string;
      uploadToken: string;
    };
    try {
      auth = await api("/api/v1/uploads/authorize", {
        method: "POST",
        headers: { "x-csrf-token": adminCsrf },
        body: JSON.stringify({
          filename: file.name,
          bytes: file.size,
          mime: file.type || "application/octet-stream",
        }),
      });
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : "无法开始上传");
      return;
    }
    speedRef.current = { at: performance.now(), bytes: 0, smoothed: 0 };
    setUploadProgress({
      id: auth.uploadId,
      filename: file.name,
      uploaded: 0,
      total: file.size,
      bytesPerSecond: 0,
      state: "uploading",
    });
    const upload = new tus.Upload(file, {
      endpoint: auth.tusEndpoint,
      headers: { "Upload-Token": auth.uploadToken },
      metadata: {
        filename: file.name,
        filetype: file.type || "application/octet-stream",
      },
      chunkSize: 16 * 1024 * 1024,
      retryDelays: [0, 1000, 3000, 5000],
      removeFingerprintOnSuccess: true,
      onProgress(bytesUploaded, bytesTotal) {
        const current = performance.now();
        const elapsed = Math.max(1, current - speedRef.current.at) / 1000;
        const instant = (bytesUploaded - speedRef.current.bytes) / elapsed;
        const smoothed =
          speedRef.current.smoothed === 0
            ? Math.max(0, instant)
            : speedRef.current.smoothed * 0.72 + Math.max(0, instant) * 0.28;
        speedRef.current = { at: current, bytes: bytesUploaded, smoothed };
        setUploadProgress((previous) =>
          previous
            ? {
                ...previous,
                uploaded: bytesUploaded,
                total: bytesTotal,
                bytesPerSecond: smoothed,
              }
            : null,
        );
      },
      onError(error) {
        uploadRef.current = null;
        setUploadProgress((previous) =>
          previous
            ? { ...previous, state: "failed", message: error.message }
            : null,
        );
      },
      onSuccess() {
        uploadRef.current = null;
        setUploadProgress((previous) =>
          previous
            ? {
                ...previous,
                uploaded: previous.total,
                state: "processing",
                message: "上传完成，正在检片入库",
              }
            : null,
        );
        void queryClient.invalidateQueries({ queryKey: ["media"] });
      },
    });
    uploadRef.current = upload;
    upload.start();
  }

  async function cancelUpload() {
    const current = uploadProgress;
    if (!adminCsrf || !current || current.state !== "uploading") return;
    setUploadProgress({
      ...current,
      state: "cancelling",
      message: "正在终止上传…",
    });
    try {
      try {
        await uploadRef.current?.abort(true);
      } catch {
        // 即使浏览器端 tus 中止失败，也必须继续请求服务端撤销并清理临时数据。
      }
      await api(`/api/v1/uploads/${current.id}`, {
        method: "DELETE",
        headers: { "x-csrf-token": adminCsrf },
      });
      setUploadProgress({
        ...current,
        state: "cancelled",
        bytesPerSecond: 0,
        message: "本条上传已终止，临时数据已清理",
      });
    } catch (error) {
      setUploadProgress({
        ...current,
        state: "failed",
        bytesPerSecond: 0,
        message: error instanceof ApiError ? error.message : "终止上传失败",
      });
    } finally {
      uploadRef.current = null;
    }
  }

  async function uploadSubtitle(mediaId: string, file: File) {
    if (!adminCsrf) return;
    await api(`/api/v1/admin/media/${mediaId}/subtitles`, {
      method: "POST",
      headers: { "x-csrf-token": adminCsrf },
      body: JSON.stringify({
        language: "zh-CN",
        label: file.name,
        content: await file.text(),
      }),
    });
    setMessage(`字幕 ${file.name} 已进入处理队列`);
    await queryClient.invalidateQueries({ queryKey: ["media"] });
  }

  async function deleteMedia(ids: string[]) {
    if (!adminCsrf || ids.length === 0) return;
    if (!confirm(`确认将 ${ids.length} 条影片移入回收站？`)) return;
    const failed: Array<{ id: string; message: string }> = [];
    let deleted = 0;
    for (const id of ids) {
      try {
        await api<void>(`/api/v1/admin/media/${id}`, {
          method: "DELETE",
          headers: { "x-csrf-token": adminCsrf },
        });
        deleted += 1;
      } catch (error) {
        failed.push({
          id,
          message: error instanceof ApiError ? error.message : "删除影片失败",
        });
      }
    }
    setSelectedMedia(failed.map((item) => item.id));
    setMessage(
      failed.length === 0
        ? `${deleted} 条影片已移入回收站，将在 24 小时后彻底清理`
        : `已删除 ${deleted} 条，${failed.length} 条未删除：${failed
            .map((item) => item.message)
            .join("；")}`,
    );
    await queryClient.invalidateQueries({ queryKey: ["media"] });
  }

  async function rescanMedia(mediaId: string) {
    if (!adminCsrf) return;
    await api(`/api/v1/admin/media/${mediaId}/rescan`, {
      method: "POST",
      headers: { "x-csrf-token": adminCsrf },
    });
    setMessage("已重新送检；服务器将按新的兼容规则重封装并入库");
    await queryClient.invalidateQueries({ queryKey: ["media"] });
  }

  async function logout() {
    if (!adminCsrf) return;
    await api<void>("/api/v1/auth/logout", {
      method: "POST",
      headers: { "x-csrf-token": adminCsrf },
      body: "{}",
    });
    useSession.getState().clear();
    void navigate("/", { replace: true });
  }

  if (!adminCsrf) {
    return (
      <main className="console-shell login-shell">
        <Link to="/" className="brand-mark">
          SW / 返回门厅
        </Link>
        <section className="login-card" aria-live="polite">
          <p className="eyebrow">PROJECTIONIST SESSION</p>
          <h1>正在验证 Host 账户</h1>
          <p className="muted-copy">控制台不再接受独立六位口令。</p>
        </section>
      </main>
    );
  }

  const progressPercent = uploadProgress
    ? Math.min(
        100,
        (uploadProgress.uploaded / Math.max(1, uploadProgress.total)) * 100,
      )
    : 0;
  const remainingSeconds =
    uploadProgress && uploadProgress.bytesPerSecond > 0
      ? (uploadProgress.total - uploadProgress.uploaded) /
        uploadProgress.bytesPerSecond
      : null;

  return (
    <main className="console-shell">
      <header className="console-header">
        <div>
          <span className="brand-mark">SIMPLEWATCH</span>
          <h1>放映控制</h1>
        </div>
        <div className="header-actions">
          <span className="status-pill">
            <i /> HOST VERIFIED
          </span>
          <button
            type="button"
            className="text-button"
            onClick={() => void logout()}
          >
            退出账户
          </button>
        </div>
      </header>
      <div className="console-grid">
        <section className="panel room-panel">
          <div className="panel-title">
            <span>01</span>
            <h2>放映控制模块</h2>
          </div>
          {activeRoom.data ? (
            <div className="room-monitor">
              <div className="monitor-primary">
                <strong>
                  {activeRoom.data.content?.title ?? "等待选择观看内容"}
                </strong>
                <span>{modeLabel(activeRoom.data.mode)}</span>
              </div>
              <dl>
                <div>
                  <dt>主持人</dt>
                  <dd>{activeRoom.data.host?.nickname ?? "—"}</dd>
                </div>
                <div>
                  <dt>在场</dt>
                  <dd>
                    {activeRoom.data.memberCount} / {activeRoom.data.maxMembers}
                  </dd>
                </div>
                <div>
                  <dt>在线</dt>
                  <dd>{activeRoom.data.onlineCount}</dd>
                </div>
                <div>
                  <dt>OBS</dt>
                  <dd>{liveLabel(activeRoom.data.live.state)}</dd>
                </div>
              </dl>
              <p className="muted-copy">
                固定账户会自动发现本房间，无需复制或更新好友链接。
              </p>
              <div className="room-actions">
                <button type="button" onClick={() => void enterHostRoom()}>
                  进入主持房间
                </button>
                <button
                  type="button"
                  className="danger-button"
                  onClick={() => void forceCloseRoom()}
                >
                  强制关闭房间
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={createRoom} className="stack-form">
              <p className="muted-copy">
                系统同时只开放一间放映室。Host
                固定为主持席；好友登录后会自动入场。
              </p>
              <button type="submit">开启放映室 →</button>
            </form>
          )}
        </section>

        <section className="panel upload-panel">
          <div className="panel-title">
            <span>02</span>
            <h2>送片入库</h2>
          </div>
          <label
            className={`drop-zone ${uploadProgress?.state === "uploading" ? "disabled" : ""}`}
          >
            <input
              type="file"
              accept="video/*,.mp4,.mkv,.mov,.m4v,.webm,.avi,.ts,.mts"
              disabled={
                uploadProgress?.state === "uploading" ||
                uploadProgress?.state === "cancelling"
              }
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.currentTarget.value = "";
                if (file) void uploadFile(file);
              }}
            />
            <strong>选择影片</strong>
            <small>
              可选择 MP4、MKV、MOV
              等常见视频；服务器只重封装和必要的音频转换，不重编码视频
            </small>
          </label>
          {uploadProgress && (
            <div className="upload-progress" aria-live="polite">
              <div className="upload-progress-head">
                <strong>{uploadProgress.filename}</strong>
                <span>{progressPercent.toFixed(1)}%</span>
              </div>
              <progress max={100} value={progressPercent} />
              <div className="upload-metrics">
                <span>
                  {formatBytes(uploadProgress.uploaded)} /{" "}
                  {formatBytes(uploadProgress.total)}
                </span>
                <span>{formatSpeed(uploadProgress.bytesPerSecond)}</span>
                <span>
                  {remainingSeconds === null
                    ? "剩余时间计算中"
                    : `约 ${formatEta(remainingSeconds)}`}
                </span>
              </div>
              {uploadProgress.message && <p>{uploadProgress.message}</p>}
              {uploadProgress.state === "uploading" && (
                <button
                  type="button"
                  className="danger-button"
                  onClick={() => void cancelUpload()}
                >
                  终止本条上传
                </button>
              )}
            </div>
          )}
          <output className="upload-status" aria-live="polite">
            {message}
          </output>
        </section>

        <section className="panel media-panel">
          <div className="panel-title">
            <span>03</span>
            <h2>片库</h2>
            <b>{media.data?.length ?? 0} REELS</b>
            {selectedMedia.length > 0 && (
              <button
                type="button"
                className="danger-button"
                onClick={() => void deleteMedia(selectedMedia)}
              >
                删除选中（{selectedMedia.length}）
              </button>
            )}
          </div>
          <div className="media-list">
            {media.data?.map((item, index) => (
              <article key={item.id} className="media-row">
                <input
                  aria-label={`选择 ${item.displayName}`}
                  type="checkbox"
                  checked={selectedMedia.includes(item.id)}
                  onChange={(event) =>
                    setSelectedMedia((previous) =>
                      event.target.checked
                        ? [...previous, item.id]
                        : previous.filter((id) => id !== item.id),
                    )
                  }
                />
                <span className="reel-number">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div>
                  <h3>{item.displayName}</h3>
                  <p>
                    {formatBytes(item.bytes)} ·{" "}
                    {item.durationMs
                      ? formatDuration(item.durationMs)
                      : "检查中"}{" "}
                    · {codecLabel(item)}
                  </p>
                </div>
                <span className={`media-state state-${item.state}`}>
                  {stateLabel(item.state)}
                </span>
                {item.compatibilityReasons.length > 0 && (
                  <small className="media-reason">
                    {item.compatibilityReasons.join("；")}
                  </small>
                )}
                {item.state === "incompatible" && (
                  <button
                    type="button"
                    onClick={() => void rescanMedia(item.id)}
                  >
                    按新规则重检
                  </button>
                )}
                {item.state === "published" && (
                  <label className="subtitle-upload">
                    添加 WebVTT 字幕
                    <input
                      aria-label={`为 ${item.displayName} 添加字幕`}
                      type="file"
                      accept=".vtt,text/vtt"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void uploadSubtitle(item.id, file);
                      }}
                    />
                  </label>
                )}
                <button
                  type="button"
                  className="text-button danger"
                  onClick={() => void deleteMedia([item.id])}
                >
                  删除
                </button>
              </article>
            ))}
            {!media.data?.length && (
              <p className="empty-state">片库为空。选择一条影片开始入库。</p>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
function formatSpeed(bytesPerSecond: number) {
  return bytesPerSecond > 0 ? `${formatBytes(bytesPerSecond)}/s` : "测速中";
}
function formatEta(seconds: number) {
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
  return `${Math.ceil(seconds / 60)} 分钟`;
}
function formatDuration(ms: number) {
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
function codecLabel(item: MediaItem) {
  if (item.video.codec === "hevc") return "H.265 · 终端相关";
  if (item.video.codec === "h264") return "H.264 · 广泛兼容";
  return "编码待识别";
}
function stateLabel(state: MediaItem["state"]) {
  return (
    {
      scanning: "检片中",
      compatible: "兼容",
      published: "可放映",
      incompatible: "不兼容",
      failed: "失败",
    } as const
  )[state];
}
function modeLabel(mode: ActiveRoomSummary["mode"]) {
  return ({ idle: "等待节目", vod: "片库点播", live: "OBS 直播" } as const)[
    mode
  ];
}
function liveLabel(state: ActiveRoomSummary["live"]["state"]) {
  return (
    { online: "推流在线", offline: "未推流", unknown: "状态未知" } as const
  )[state];
}
