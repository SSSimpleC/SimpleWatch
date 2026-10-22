import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  EdgeTransfer,
  ProgramQueue,
  ProgramQueueItem,
  RoomCommandRequest,
  PlaybackStatus,
  PlaybackStatusSummary,
} from "@simplewatch/contracts";
import {
  playbackStatusSummarySchema,
  roomCommandAppliedSchema,
  roomSnapshotSchema,
} from "@simplewatch/contracts";
import {
  estimateClock,
  selectStableClockEstimate,
  type ClockEstimate,
} from "@simplewatch/sync";
import type { Room as LiveKitRoom } from "livekit-client";
import { v7 as uuidv7 } from "uuid";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Link, useNavigate, useParams } from "react-router";

import {
  api,
  ApiError,
  type LiveStatus,
  type MediaItem,
  type RoomSnapshot,
} from "../api.js";
import { adminQueryKeys, hasHostControls } from "../admin-data.js";
import { decideProgramTrack, replaceRetryTimer } from "../live-program.js";
import { LiveStatsSampler, type LiveViewerStats } from "../live-stats.js";
import { LiveFreezeRecovery } from "../live-playback.js";
import { RoomCommandQueue } from "../room-command-queue.js";
import {
  MonotonicServerClock,
  VodPlaybackController,
  type VodStatus,
  type VodMediaEvent,
} from "../vod-controller.js";
import { mediaErrorMessage, vodPhaseLabel } from "../player-ui.js";
export { classifyViewerHealth, type LiveViewerStats } from "../live-stats.js";
import { averageBitrateMbps, isHighLoadVod } from "../media-performance.js";
import { loadPreferences, savePreferences } from "../preferences.js";
import {
  buildPlaybackProgress,
  buildProgramActivationCommand,
  currentProgramItem,
  departureCoverageRatio,
  nextPlaybackSequence,
  PendingProgramCommands,
  shouldLoadHostProgram,
  type DepartureDecision,
  type PendingProgramActivation,
} from "../room-program.js";
import { useSession } from "../store.js";
import { DepartureDecisionDialog } from "./room/DepartureDecisionDialog.js";
import { HostProgramQueue } from "./room/HostProgramQueue.js";

export function RoomPage() {
  const { roomId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { account, adminCsrf, roomCsrf, setRoomCsrf, memberId, setMemberId } =
    useSession();
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [theaterMode, setTheaterMode] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const screenRef = useRef<HTMLElement | null>(null);
  const voiceRoomRef = useRef<LiveKitRoom | null>(null);
  const voiceTracksRef = useRef<HTMLDivElement | null>(null);
  const liveReaderRef = useRef<{
    close(): void;
    getPeerConnection(): RTCPeerConnection | null;
  } | null>(null);
  const liveStreamRef = useRef<MediaStream | null>(null);
  const liveTracksRef = useRef(new Map<"audio" | "video", MediaStreamTrack>());
  const liveReaderGenerationRef = useRef(0);
  const liveRetryTimerRef = useRef(0);
  const rejectedLiveTracksRef = useRef(0);
  const liveSamplerRef = useRef(new LiveStatsSampler());
  const liveRecoveryRef = useRef(new LiveFreezeRecovery());
  const liveConnectingRef = useRef(false);
  const liveRetryBlockedRef = useRef(false);
  const liveHasFrameRef = useRef(false);
  const liveStateRef = useRef<"idle" | "connecting" | "playing" | "error">(
    "idle",
  );
  const liveStatsRef = useRef<LiveViewerStats | null>(null);
  const frameRef = useRef<{
    mediaTime: number;
    presentedFrames: number;
  } | null>(null);
  const frameGenerationRef = useRef(0);
  const frameCancelRef = useRef<(() => void) | null>(null);
  const frameModeRef = useRef<RoomSnapshot["mode"] | null>(null);
  const roomIdRef = useRef(roomId);
  const roomGenerationRef = useRef(0);
  const socketGenerationRef = useRef(0);
  const refreshRequestRef = useRef<string | null>(null);
  const refreshTimerRef = useRef(0);
  const mountedRef = useRef(true);
  const serverClockRef = useRef(
    new MonotonicServerClock(() => performance.now(), Date.now()),
  );
  const vodControllerRef = useRef<VodPlaybackController | null>(null);
  const vodStatusRef = useRef<VodStatus | null>(null);
  const lastVodUiRef = useRef(0);
  const commandQueueRef = useRef<RoomCommandQueue | null>(null);
  const traceRef = useRef<Array<Record<string, string | number | null>>>([]);
  const stallCountRef = useRef(0);
  const seekingRef = useRef(false);
  const seekDraftRef = useRef<number | null>(null);
  const pendingSeekRef = useRef<{
    commandId: string;
    revision?: number;
  } | null>(null);
  const clockOffsetMsRef = useRef<number | null>(null);
  const clockSamplesRef = useRef<ClockEstimate[]>([]);
  const clockBurstTimersRef = useRef<number[]>([]);
  const closingRoomRef = useRef(false);
  const latestSnapshotRef = useRef<RoomSnapshot | null>(null);
  const latestProgramRef = useRef<ProgramQueue | null | undefined>(undefined);
  const latestIsHostRef = useRef(false);
  const programEnabledRef = useRef(false);
  const [programEnabled, setProgramEnabled] = useState(false);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [bufferedAheadSec, setBufferedAheadSec] = useState(0);
  const [syncDeltaMs, setSyncDeltaMs] = useState<number | null>(null);
  const [clockRttMs, setClockRttMs] = useState<number | null>(null);
  const [syncFailed, setSyncFailed] = useState(false);
  const [vodStatus, setVodStatus] = useState<VodStatus | null>(null);
  const [commandState, setCommandState] = useState("");
  const [pendingCommandCount, setPendingCommandCount] = useState(0);
  const [playbackReports, setPlaybackReports] =
    useState<PlaybackStatusSummary | null>(null);
  const [seekDraftSec, setSeekDraftSec] = useState<number | null>(null);
  const [pendingSeekSec, setPendingSeekSec] = useState<number | null>(null);
  const [liveProgramState, setLiveProgramState] = useState<
    "idle" | "connecting" | "playing" | "error"
  >("idle");
  const [liveRetry, setLiveRetry] = useState(0);
  const [liveStats, setLiveStats] = useState<LiveViewerStats | null>(null);
  const [voiceState, setVoiceState] = useState<
    "idle" | "connecting" | "connected" | "error"
  >("idle");
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
  const [preferences, setPreferences] = useState(loadPreferences);
  const [publishConfig, setPublishConfig] = useState<{
    url: string;
    token: string;
  } | null>(null);
  const [publishConfigError, setPublishConfigError] = useState("");
  const pendingProgramCommandsRef = useRef(new PendingProgramCommands());
  const activationTriggerRef = useRef<HTMLButtonElement | null>(null);
  const progressSequenceRef = useRef(0);
  const [pendingProgramItemId, setPendingProgramItemId] = useState<
    string | null
  >(null);
  const [departurePrompt, setDeparturePrompt] = useState<{
    activation: PendingProgramActivation;
    coveredRatio: number | null;
  } | null>(null);
  const isHost = hasHostControls(
    account?.role,
    memberId,
    snapshot?.hostMemberId,
  );
  const media = useQuery({
    queryKey: ["room-media", snapshot?.media?.id],
    queryFn: () => api<MediaItem>(`/api/v1/media/${snapshot?.media?.id ?? ""}`),
    enabled: Boolean(snapshot?.media?.id),
  });
  const library = useQuery({
    queryKey: adminQueryKeys.media,
    queryFn: () => api<MediaItem[]>("/api/v1/media"),
    enabled: isHost && Boolean(adminCsrf),
  });
  const hostProgramEnabled = shouldLoadHostProgram(isHost, adminCsrf);
  const program = useQuery({
    queryKey: adminQueryKeys.program,
    queryFn: () => api<ProgramQueue | null>("/api/v1/admin/program"),
    enabled: hostProgramEnabled,
    refetchInterval: hostProgramEnabled ? 5000 : false,
  });
  const edgeTransfers = useQuery({
    queryKey: adminQueryKeys.edgeTransfers,
    queryFn: () => api<EdgeTransfer[]>("/api/v1/admin/edge/transfers"),
    enabled: hostProgramEnabled,
    refetchInterval: hostProgramEnabled ? 5000 : false,
  });
  const liveStatus = useQuery({
    queryKey: ["live-status", roomId],
    queryFn: () => api<LiveStatus>(`/api/v1/rooms/${roomId}/live/status`),
    enabled: joined && snapshot?.mode === "live",
    refetchInterval: 2000,
  });
  const durationSec =
    snapshot?.media?.durationSec ?? (media.data?.durationMs ?? 0) / 1000;
  const displayedPositionSec = clamp(
    seekDraftSec ?? pendingSeekSec ?? playheadSec,
    0,
    durationSec,
  );
  const hostControlsReady =
    isHost &&
    connected &&
    snapshot?.capabilities?.commandAck === true &&
    !commandQueueRef.current?.getState().frozen;
  const bitrateMbps = averageBitrateMbps(media.data);
  const onlinePlaybackEndpoints =
    snapshot?.members.filter((member) => member.online).length ?? 0;
  const aggregateBitrateMbps = bitrateMbps * onlinePlaybackEndpoints;
  const highLoadVod = isHighLoadVod(media.data);
  const programMediaIds = new Set(
    program.data?.items.flatMap((item) =>
      item.mediaId ? [item.mediaId] : [],
    ) ?? [],
  );

  roomIdRef.current = roomId;
  latestProgramRef.current = program.data;
  latestIsHostRef.current = isHost;
  programEnabledRef.current = programEnabled;

  useEffect(() => {
    mountedRef.current = true;
    roomGenerationRef.current += 1;
    latestSnapshotRef.current = null;
    vodControllerRef.current?.reset();
    commandQueueRef.current?.reset();
    liveRetryBlockedRef.current = false;
    liveRecoveryRef.current = new LiveFreezeRecovery();
    traceRef.current = [];
    setJoined(false);
    setSnapshot(null);
    setPlaybackReports(null);
    return () => {
      mountedRef.current = false;
      window.clearTimeout(refreshTimerRef.current);
      vodControllerRef.current?.reset();
      commandQueueRef.current?.reset();
    };
  }, [roomId]);

  useEffect(() => {
    let active = true;
    void api<{ snapshot: RoomSnapshot; memberId: string; csrfToken: string }>(
      `/api/v1/rooms/${roomId}/bootstrap`,
    )
      .then((bootstrap) => {
        if (!active) return;
        setRoomCsrf(bootstrap.csrfToken);
        setMemberId(bootstrap.memberId);
        acceptRoomSnapshot(bootstrap.snapshot);
        clockOffsetMsRef.current = bootstrap.snapshot.serverNowMs - Date.now();
        serverClockRef.current.calibrate(bootstrap.snapshot.serverNowMs);
        setJoined(true);
      })
      .catch(() => setError("当前设备未持有观影席，请返回门厅重新接管"));
    return () => {
      active = false;
    };
  }, [roomId, setMemberId, setRoomCsrf]);

  useEffect(() => savePreferences(preferences), [preferences]);

  useEffect(() => {
    if (videoRef.current)
      videoRef.current.volume = preferences.programVolume / 100;
  }, [preferences.programVolume, snapshot?.mode]);

  useEffect(() => {
    voiceTracksRef.current
      ?.querySelectorAll<HTMLAudioElement>("audio[data-participant-id]")
      .forEach((element) => {
        element.volume = remoteVolume(
          element.dataset.participantId ?? "",
          preferences,
        );
      });
  }, [preferences]);

  useEffect(() => {
    if (!preferences.pushToTalk || voiceState !== "connected") return;
    const isTyping = (target: EventTarget | null) =>
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement;
    const down = (event: KeyboardEvent) => {
      if (event.code === "Space" && !event.repeat && !isTyping(event.target))
        void voiceRoomRef.current?.localParticipant
          .setMicrophoneEnabled(true)
          .then(() => setMicrophoneEnabled(true));
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === "Space" && !isTyping(event.target))
        void voiceRoomRef.current?.localParticipant
          .setMicrophoneEnabled(false)
          .then(() => setMicrophoneEnabled(false));
    };
    void voiceRoomRef.current?.localParticipant
      .setMicrophoneEnabled(false)
      .then(() => setMicrophoneEnabled(false));
    addEventListener("keydown", down);
    addEventListener("keyup", up);
    return () => {
      removeEventListener("keydown", down);
      removeEventListener("keyup", up);
    };
  }, [preferences.pushToTalk, voiceState]);

  useEffect(() => {
    sessionStorage.setItem(
      "simplewatch.room-state",
      JSON.stringify({
        roomId: roomId.slice(0, 8),
        connected,
        voiceState,
        revision: snapshot?.revision ?? null,
      }),
    );
  }, [connected, roomId, snapshot?.revision, voiceState]);

  useEffect(() => {
    progressSequenceRef.current = 0;
    pendingProgramCommandsRef.current.clear();
    setPendingProgramItemId(null);
    setDeparturePrompt(null);
  }, [roomId]);

  useEffect(() => {
    if (isHost) return;
    pendingProgramCommandsRef.current.clear();
    setPendingProgramItemId(null);
    setDeparturePrompt(null);
  }, [isHost]);

  useEffect(() => {
    if (!hostProgramEnabled) return;
    const timer = window.setInterval(() => {
      sendPlaybackProgress();
    }, 5000);
    const reportBeforeLeave = () => {
      sendPlaybackProgress();
    };
    const reportWhenHidden = () => {
      if (document.visibilityState === "hidden") sendPlaybackProgress();
    };
    addEventListener("pagehide", reportBeforeLeave);
    document.addEventListener("visibilitychange", reportWhenHidden);
    return () => {
      sendPlaybackProgress();
      window.clearInterval(timer);
      removeEventListener("pagehide", reportBeforeLeave);
      document.removeEventListener("visibilitychange", reportWhenHidden);
    };
  }, [hostProgramEnabled, roomId]);

  useEffect(() => {
    setSeekDraftSec(null);
    seekDraftRef.current = null;
    seekingRef.current = false;
    setPlayheadSec(0);
    setBufferedAheadSec(0);
    stallCountRef.current = 0;
  }, [snapshot?.media?.id, snapshot?.mode]);

  useEffect(() => {
    if (!joined || !isHost || snapshot?.mode !== "live" || publishConfig)
      return;
    let cancelled = false;
    setPublishConfigError("");
    void api<{ url: string; token: string }>(
      `/api/v1/rooms/${roomId}/live/publish-config`,
      { method: "GET" },
    )
      .then((result) => {
        if (!cancelled) setPublishConfig(result);
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setPublishConfigError(
            reason instanceof Error ? reason.message : "OBS 配置获取失败",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [isHost, joined, publishConfig, roomId, snapshot?.mode]);

  useEffect(() => {
    if (!joined) return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    let disposed = false;
    let retryTimer = 0;
    let retryAttempt = 0;

    const connect = () => {
      if (disposed) return;
      const generation = ++socketGenerationRef.current;
      const socket = new WebSocket(
        `${protocol}//${location.host}/api/v1/rooms/${roomId}/ws`,
        "simplewatch.v1",
      );
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        if (
          disposed ||
          socketRef.current !== socket ||
          generation !== socketGenerationRef.current
        )
          return;
        retryAttempt = 0;
        setConnected(true);
        refreshRoomSnapshot();
        scheduleClockBurst(socket);
      });
      socket.addEventListener("close", (event) => {
        if (
          disposed ||
          socketRef.current !== socket ||
          generation !== socketGenerationRef.current
        )
          return;
        setConnected(false);
        window.clearTimeout(refreshTimerRef.current);
        refreshRequestRef.current = null;
        if ([4001, 4003, 4010].includes(event.code)) {
          closeLiveProgram();
          void voiceRoomRef.current?.disconnect().catch(() => undefined);
          voiceRoomRef.current = null;
          setVoiceState("idle");
          if (event.code === 4010 && closingRoomRef.current) return;
          setError(
            event.code === 4003
              ? "你已被主持人移出放映室"
              : event.code === 4010
                ? "放映室已关闭"
                : "你已退出放映室",
          );
          void navigate("/", { replace: true });
          return;
        }
        const delay = Math.min(15_000, 1000 * 2 ** retryAttempt);
        retryAttempt += 1;
        retryTimer = window.setTimeout(connect, delay);
      });
      socket.addEventListener("message", (event) => {
        if (
          disposed ||
          socketRef.current !== socket ||
          generation !== socketGenerationRef.current
        )
          return;
        let message: {
          type: string;
          payload: unknown;
          replyTo?: string;
        };
        try {
          message = JSON.parse(String(event.data)) as typeof message;
        } catch {
          return;
        }
        if (
          message.type === "room.snapshot" ||
          message.type === "host.changed"
        ) {
          const parsed = roomSnapshotSchema.safeParse(message.payload);
          if (!parsed.success) return;
          const next = parsed.data;
          const authoritative =
            message.replyTo !== undefined &&
            message.replyTo === refreshRequestRef.current;
          if (authoritative) {
            window.clearTimeout(refreshTimerRef.current);
            refreshRequestRef.current = null;
          }
          // Consume this reply before accepting it: rejecting an old revision
          // can synchronously start a new refresh whose timer must survive.
          acceptRoomSnapshot(next, authoritative);
          if (clockOffsetMsRef.current === null)
            clockOffsetMsRef.current = next.serverNowMs - Date.now();
        }
        if (message.type === "room.command.applied") {
          const parsed = roomCommandAppliedSchema.safeParse(message.payload);
          if (!parsed.success || parsed.data.currentSnapshot.roomId !== roomId)
            return;
          const receipt = parsed.data;
          acceptRoomSnapshot(receipt.currentSnapshot);
          getCommandQueue().acknowledge(
            receipt.commandId,
            receipt.revision,
            receipt.currentSnapshot.revision,
          );
          recordPlayerEvent(
            "command-applied",
            receipt.commandId,
            receipt.revision,
          );
        }
        if (
          message.type === "playback.status.summary" &&
          latestIsHostRef.current
        ) {
          const parsed = playbackStatusSummarySchema.safeParse(message.payload);
          if (parsed.success) setPlaybackReports(parsed.data);
        }
        if (message.type === "clock.pong") {
          const pong = message.payload as {
            clientSentAtMs: number;
            serverReceivedAtMs: number;
            serverSentAtMs: number;
          };
          const estimate = estimateClock({
            ...pong,
            clientReceivedAtMs: Date.now(),
          });
          clockSamplesRef.current = [
            ...clockSamplesRef.current.slice(-6),
            estimate,
          ];
          const stable = selectStableClockEstimate(clockSamplesRef.current);
          if (stable) {
            clockOffsetMsRef.current = stable.offsetMs;
            serverClockRef.current.calibrate(Date.now() + stable.offsetMs);
            setClockRttMs(Math.round(stable.roundTripMs));
          }
        }
        if (message.type === "room.command.rejected") {
          const rejection = message.payload as {
            commandId?: string | null;
            code?: string;
            message?: string;
            details?: unknown;
          };
          const pending = pendingProgramCommandsRef.current.take(
            rejection.commandId,
          );
          if (rejection.commandId)
            getCommandQueue().reject(
              rejection.commandId,
              rejection.code ?? "command-rejected",
            );
          if (pending) {
            setPendingProgramItemId(null);
            if (rejection.code === "PROGRAM_DEPARTURE_DECISION_REQUIRED") {
              setDeparturePrompt({
                activation: pending,
                coveredRatio: departureCoverageRatio(rejection.details),
              });
            } else {
              setError(rejection.message ?? "节目切换未生效");
              restoreActivationFocus();
            }
            void queryClient.invalidateQueries({
              queryKey: adminQueryKeys.program,
            });
          } else if (rejection.code !== "PLAYBACK_PROGRESS_STALE") {
            setError(rejection.message ?? "操作未生效，状态已刷新");
          }
        }
      });
    };

    connect();
    const calibrationTimer = window.setInterval(() => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) scheduleClockBurst(socket, 3);
    }, 30_000);
    const recalibrate = () => {
      getVodController().setVisible(document.visibilityState !== "hidden");
      if (document.visibilityState === "hidden") {
        liveRecoveryRef.current.shouldRecover({
          generation: liveReaderGenerationRef.current,
          atMs: performance.now(),
          foreground: false,
          enabled: programEnabledRef.current,
          started: liveHasFrameRef.current,
          videoBytesReceived: null,
          renderedFrames: null,
        });
        return;
      }
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        scheduleClockBurst(socket);
        refreshRoomSnapshot();
      }
    };
    document.addEventListener("visibilitychange", recalibrate);
    addEventListener("online", recalibrate);
    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      window.clearInterval(calibrationTimer);
      window.clearTimeout(refreshTimerRef.current);
      refreshRequestRef.current = null;
      clockBurstTimersRef.current.forEach(window.clearTimeout);
      clockBurstTimersRef.current = [];
      document.removeEventListener("visibilitychange", recalibrate);
      removeEventListener("online", recalibrate);
      socketRef.current?.close(1000, "page leave");
      socketRef.current = null;
    };
  }, [joined, navigate, queryClient, roomId]);

  useEffect(() => {
    reconcileVod("snapshot");
  }, [
    durationSec,
    programEnabled,
    snapshot?.mode,
    snapshot?.revision,
    snapshot?.transport,
  ]);

  useEffect(() => {
    if (!joined) return;
    const timer = window.setInterval(() => {
      commandQueueRef.current?.tick();
      if (latestSnapshotRef.current?.mode === "vod") reconcileVod("periodic");
    }, 250);
    return () => window.clearInterval(timer);
  }, [joined, roomId]);

  useEffect(() => {
    startFrameObservation();
    return () => frameCancelRef.current?.();
  }, [joined, snapshot?.mode, snapshot?.media?.id]);

  function startFrameObservation() {
    frameCancelRef.current?.();
    const video = videoRef.current;
    const generation = ++frameGenerationRef.current;
    const current = latestSnapshotRef.current;
    const mode = current?.mode;
    const mediaId = current?.media?.id;
    const readerGeneration = liveReaderGenerationRef.current;
    const sourceObject = video?.srcObject;
    frameModeRef.current = mode ?? null;
    frameRef.current = null;
    liveHasFrameRef.current = false;
    if (
      !video ||
      typeof video.requestVideoFrameCallback !== "function" ||
      (mode === "live" && !sourceObject)
    )
      return;
    let handle = 0;
    let cancelled = false;
    const frame: VideoFrameRequestCallback = (_now, metadata) => {
      if (
        cancelled ||
        generation !== frameGenerationRef.current ||
        video !== videoRef.current ||
        latestSnapshotRef.current?.mode !== mode ||
        latestSnapshotRef.current?.media?.id !== mediaId ||
        (mode === "live" &&
          (readerGeneration !== liveReaderGenerationRef.current ||
            video.srcObject !== sourceObject))
      )
        return;
      frameRef.current = {
        mediaTime: metadata.mediaTime,
        presentedFrames: metadata.presentedFrames,
      };
      if (latestSnapshotRef.current?.mode === "vod")
        getVodController().notifyMediaEvent("frame", frameRef.current);
      if (latestSnapshotRef.current?.mode === "live") {
        liveHasFrameRef.current = true;
        if (liveStateRef.current !== "playing") {
          liveStateRef.current = "playing";
          setLiveProgramState("playing");
        }
      }
      handle = video.requestVideoFrameCallback(frame);
    };
    handle = video.requestVideoFrameCallback(frame);
    frameCancelRef.current = () => {
      cancelled = true;
      video.cancelVideoFrameCallback?.(handle);
    };
  }

  useEffect(() => {
    if (!joined) return;
    const timer = window.setInterval(() => sendPlaybackStatus(), 2000);
    return () => window.clearInterval(timer);
  }, [joined, roomId]);

  useEffect(() => {
    if (snapshot?.mode !== "live" || isHost || !programEnabled) return;
    const update = () => void collectLiveStats();
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [isHost, programEnabled, snapshot?.mode]);

  useEffect(() => {
    if (snapshot?.mode !== "live" || isHost) {
      closeLiveProgram();
      return;
    }
    if (!programEnabled || liveStatus.data?.state !== "online") {
      if (liveStatus.data?.state === "offline") closeLiveProgram();
      return;
    }
    if (
      !liveReaderRef.current &&
      !liveConnectingRef.current &&
      !liveRetryBlockedRef.current &&
      !liveRetryTimerRef.current
    )
      void enableLiveProgram();
  }, [
    isHost,
    liveRetry,
    liveStatus.data?.state,
    programEnabled,
    snapshot?.mode,
  ]);

  useEffect(
    () => () => {
      void voiceRoomRef.current?.disconnect().catch(() => undefined);
      voiceRoomRef.current = null;
      closeLiveProgram();
    },
    [],
  );

  function commandContext(current = latestSnapshotRef.current) {
    return {
      roomId: roomIdRef.current,
      mediaId: current?.mode === "vod" ? (current.media?.id ?? null) : null,
      generation: roomGenerationRef.current,
    };
  }

  function recordPlayerEvent(
    event: string,
    commandId?: string,
    revision?: number,
  ) {
    const current = latestSnapshotRef.current;
    traceRef.current = [
      ...traceRef.current.slice(-119),
      {
        event,
        serverAtMs: Math.round(serverClockRef.current.serverNowMs()),
        commandId: commandId ?? current?.cause?.commandId ?? null,
        revision: revision ?? current?.revision ?? null,
        mediaId: current?.media?.id ?? null,
        positionSec: finiteSeconds(videoRef.current?.currentTime),
        targetSec: vodStatusRef.current?.targetSec ?? null,
        presentedTimeSec: frameRef.current?.mediaTime ?? null,
        connectionGeneration: socketGenerationRef.current,
      },
    ];
    try {
      sessionStorage.setItem(
        "simplewatch.playback-trace",
        JSON.stringify(traceRef.current),
      );
    } catch {
      /* Diagnostics must not prevent playback when storage is unavailable. */
    }
  }

  function getCommandQueue(): RoomCommandQueue {
    commandQueueRef.current ??= new RoomCommandQueue({
      nowMs: () => performance.now(),
      serverNowMs: serverClockRef.current.serverNowMs,
      createId: () => uuidv7(),
      send: (request, context) => {
        const socket = socketRef.current;
        if (
          socket?.readyState !== WebSocket.OPEN ||
          context.roomId !== roomIdRef.current ||
          context.generation !== roomGenerationRef.current
        )
          return false;
        recordPlayerEvent(
          "command-submitted",
          request.commandId,
          request.expectedRevision,
        );
        socket.send(
          JSON.stringify(envelope(context.roomId, "room.command", request)),
        );
        return true;
      },
      onRefresh: () => refreshRoomSnapshot(),
      onChange: () => {
        if (!mountedRef.current) return;
        const state = commandQueueRef.current?.getState();
        setPendingCommandCount(state?.pendingIds.length ?? 0);
        if (state?.frozen)
          setCommandState("正在获取权威状态；未发送操作已取消");
        else if (state?.pendingIds.length)
          setCommandState(`等待服务器确认（${state.pendingIds.length}）`);
      },
      onResult: (result) => {
        if (!mountedRef.current) return;
        recordPlayerEvent(`command-${result.outcome}`, result.commandId);
        if (pendingSeekRef.current?.commandId === result.commandId) {
          if (
            result.outcome === "applied" &&
            result.executionRevision !== undefined
          )
            pendingSeekRef.current.revision = result.executionRevision;
          else {
            pendingSeekRef.current = null;
            setPendingSeekSec(null);
          }
        }
        if (result.outcome === "unknown")
          setError(
            "操作结果暂不确定，未发送操作已取消；正在获取最新状态，请勿重复提交",
          );
        if (result.outcome === "applied")
          setCommandState(
            commandQueueRef.current?.getState().frozen
              ? "原操作已确认，仍在等待最新权威状态；未发送操作已取消"
              : "服务器已确认；各观看端正在协调画面",
          );
        if (result.outcome === "rejected")
          setCommandState("操作未被接受，正在刷新状态");
        if (result.outcome === "unknown" || result.outcome === "cancelled") {
          if (pendingProgramCommandsRef.current.take(result.commandId))
            setPendingProgramItemId(null);
        }
      },
    });
    return commandQueueRef.current;
  }

  function refreshRoomSnapshot() {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return;
    const request = envelope(roomIdRef.current, "room.hello", {
      playbackStatus: latestIsHostRef.current,
    });
    refreshRequestRef.current = request.id;
    window.clearTimeout(refreshTimerRef.current);
    socket.send(JSON.stringify(request));
    refreshTimerRef.current = window.setTimeout(() => {
      if (
        socketRef.current === socket &&
        refreshRequestRef.current === request.id
      ) {
        recordPlayerEvent("snapshot-refresh-timeout");
        socket.close(4000, "state refresh timeout");
      }
    }, 5000);
  }

  function acceptRoomSnapshot(next: RoomSnapshot, authoritative = false) {
    if (next.roomId !== roomIdRef.current || !mountedRef.current) return;
    const previous = latestSnapshotRef.current;
    if (
      previous &&
      previous.roomId === next.roomId &&
      next.revision < previous.revision
    ) {
      recordPlayerEvent(
        "stale-snapshot-ignored",
        next.cause?.commandId,
        next.revision,
      );
      if (authoritative) refreshRoomSnapshot();
      return;
    }
    if (
      previous?.mode !== next.mode ||
      previous?.media?.id !== next.media?.id
    ) {
      frameCancelRef.current?.();
      frameGenerationRef.current += 1;
      frameRef.current = null;
      vodControllerRef.current?.reset();
      seekDraftRef.current = null;
      seekingRef.current = false;
      setSeekDraftSec(null);
      pendingSeekRef.current = null;
      setPendingSeekSec(null);
    }
    latestSnapshotRef.current = next;
    setSnapshot(next);
    recordPlayerEvent(
      authoritative ? "authoritative-snapshot" : "snapshot-received",
      next.cause?.commandId,
      next.revision,
    );
    if (pendingProgramCommandsRef.current.resolveSnapshot(next)) {
      setPendingProgramItemId(null);
      setDeparturePrompt(null);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: adminQueryKeys.program }),
        queryClient.invalidateQueries({
          queryKey: adminQueryKeys.edgeTransfers,
        }),
      ]);
    }
    const queue = getCommandQueue();
    queue.setContext(commandContext(next), next.revision);
    if (authoritative) {
      queue.acceptAuthoritativeSnapshot(commandContext(next), next.revision);
      if (queue.getPendingIds().length === 0) setCommandState("最新状态已恢复");
    }
    if (next.mode !== "vod") vodControllerRef.current?.reset();
  }

  function getVodController(): VodPlaybackController {
    vodControllerRef.current ??= new VodPlaybackController({
      clock: serverClockRef.current,
      media: {
        read: () => {
          const video = videoRef.current;
          return {
            currentTime: video?.currentTime ?? 0,
            duration: video?.duration ?? Number.NaN,
            readyState: video?.readyState ?? 0,
            seeking: video?.seeking ?? false,
            paused: video?.paused ?? true,
            playbackRate: video?.playbackRate ?? 1,
            bufferedAheadSec: video ? bufferedAhead(video) : 0,
            frameEvidenceSupported: Boolean(
              video && typeof video.requestVideoFrameCallback === "function",
            ),
            ...(frameRef.current ? { frame: frameRef.current } : {}),
          };
        },
        seek: (seconds) => {
          const video = videoRef.current;
          if (!video) throw new Error("video-element-unavailable");
          recordPlayerEvent("seek-requested");
          video.currentTime = seconds;
        },
        setPlaybackRate: (rate) => {
          if (videoRef.current) videoRef.current.playbackRate = rate;
        },
        play: () => videoRef.current?.play(),
        pause: () => videoRef.current?.pause(),
        setPrimingMuted: (muted) => {
          if (videoRef.current) videoRef.current.muted = muted;
        },
      },
      onStatus: (status) => {
        const previous = vodStatusRef.current;
        vodStatusRef.current = status;
        if (!mountedRef.current) return;
        const pendingSeek = pendingSeekRef.current;
        const current = latestSnapshotRef.current;
        if (
          pendingSeek?.revision !== undefined &&
          current?.transport &&
          status.mediaId === current.media?.id &&
          status.activeRevision !== null &&
          status.activeRevision >= pendingSeek.revision &&
          serverClockRef.current.serverNowMs() >=
            current.transport.anchoredAtServerMs &&
          (status.phase === "playing" || status.phase === "paused") &&
          status.frameEvidence !== "pending"
        ) {
          pendingSeekRef.current = null;
          setPendingSeekSec(null);
        }
        const changed =
          status.phase !== previous?.phase ||
          status.intentId !== previous?.intentId ||
          status.frameEvidence !== previous?.frameEvidence;
        if (changed)
          recordPlayerEvent(`vod-${status.phase}-${status.frameEvidence}`);
        if (!changed && performance.now() - lastVodUiRef.current < 250) return;
        lastVodUiRef.current = performance.now();
        setVodStatus(status);
        setSyncDeltaMs(
          status.driftSec === null ? null : Math.round(status.driftSec * 1000),
        );
        setSyncFailed(status.phase === "error");
        setPlayheadSec(videoRef.current?.currentTime ?? 0);
      },
    });
    return vodControllerRef.current;
  }

  function sendPlaybackStatus() {
    const current = latestSnapshotRef.current;
    const socket = socketRef.current;
    const video = videoRef.current;
    if (
      !current?.capabilities?.playbackStatus ||
      !video ||
      (current.mode !== "vod" && current.mode !== "live") ||
      socket?.readyState !== WebSocket.OPEN
    )
      return;
    const phase = vodStatusRef.current?.phase;
    const state: PlaybackStatus["state"] =
      current.mode === "live"
        ? liveStateRef.current === "playing"
          ? "playing"
          : liveStateRef.current === "error"
            ? "error"
            : "reconnecting"
        : phase === "disabled" || phase === "autoplay-blocked"
          ? "user-action-required"
          : phase === "preparing" || !phase
            ? "waiting-metadata"
            : phase;
    const payload: PlaybackStatus = {
      mode: current.mode,
      mediaId: current.media?.id ?? null,
      state,
      positionSec: finiteSeconds(video.currentTime),
      targetSec:
        current.mode === "vod"
          ? (vodStatusRef.current?.targetSec ?? null)
          : null,
      revision: current.revision,
      readyState: video.readyState,
      videoFrames: frameRef.current?.presentedFrames ?? null,
      fps:
        current.mode === "live"
          ? (liveStatsRef.current?.renderedFramesPerSecond ?? null)
          : null,
    };
    socket.send(
      JSON.stringify(envelope(roomIdRef.current, "playback.status", payload)),
    );
  }

  function command(
    commandPayload: RoomCommandRequest["command"],
  ): string | null {
    const current = latestSnapshotRef.current;
    if (
      !current ||
      socketRef.current?.readyState !== WebSocket.OPEN ||
      !latestIsHostRef.current
    ) {
      if (latestIsHostRef.current)
        setError("控制连接尚未就绪，操作未发送；请等待连接恢复后重试");
      return null;
    }
    if (!current.capabilities?.commandAck) {
      setError("当前服务器尚不支持可靠控制确认，请确认前后端版本并刷新页面");
      return null;
    }
    const queue = getCommandQueue();
    queue.setContext(commandContext(current), current.revision);
    const id = queue.enqueue(commandPayload);
    if (!id) setError("正在恢复权威状态，请稍后重新操作");
    return id;
  }

  function sendPlaybackProgress(playingOverride?: boolean): boolean {
    const socket = socketRef.current;
    const currentSnapshot = latestSnapshotRef.current;
    const currentProgram = latestProgramRef.current;
    if (
      socket?.readyState !== WebSocket.OPEN ||
      !latestIsHostRef.current ||
      !currentProgramItem(currentProgram, currentSnapshot?.media?.id)
    ) {
      return false;
    }
    const sequence = nextPlaybackSequence(
      roomId,
      progressSequenceRef.current,
      window.sessionStorage,
    );
    const videoPosition = videoRef.current?.currentTime;
    const progress = buildPlaybackProgress({
      isHost: latestIsHostRef.current,
      queue: currentProgram,
      snapshot: currentSnapshot,
      sequence,
      positionSec:
        typeof videoPosition === "number" && Number.isFinite(videoPosition)
          ? videoPosition
          : (currentSnapshot?.transport?.positionSec ?? 0),
      sampledAtClientMs: Date.now(),
      ...(playingOverride === undefined ? {} : { playingOverride }),
    });
    if (!progress) return false;
    progressSequenceRef.current = sequence;
    socket.send(
      JSON.stringify(envelope(roomId, "playback.progress", progress)),
    );
    return true;
  }

  function activateProgramItem(
    item: ProgramQueueItem,
    trigger: HTMLButtonElement,
  ): void {
    const currentProgram = latestProgramRef.current;
    const currentSnapshot = latestSnapshotRef.current;
    if (
      !currentProgram ||
      !currentSnapshot ||
      !item.mediaId ||
      item.preparationState !== "ready"
    ) {
      return;
    }
    activationTriggerRef.current = trigger;
    sendPlaybackProgress(false);
    sendProgramActivation(
      {
        programQueueId: currentProgram.id,
        programItemId: item.id,
        mediaId: item.mediaId,
        displayName: item.displayName,
        expectedRoomRevision: currentSnapshot.revision,
      },
      undefined,
    );
  }

  function sendProgramActivation(
    activation: PendingProgramActivation,
    decision: DepartureDecision | undefined,
  ): void {
    const currentSnapshot = latestSnapshotRef.current;
    const commandId = command(
      buildProgramActivationCommand(
        { id: activation.programQueueId },
        { id: activation.programItemId },
        decision,
      ),
    );
    if (!commandId || !currentSnapshot) {
      setError("同步连接尚未恢复，暂时不能切换节目");
      restoreActivationFocus();
      return;
    }
    const tracked = {
      ...activation,
      expectedRoomRevision: currentSnapshot.revision,
    };
    pendingProgramCommandsRef.current.track(commandId, tracked);
    setPendingProgramItemId(activation.programItemId);
    setError("");
  }

  function decideDeparture(decision: DepartureDecision): void {
    if (!departurePrompt) return;
    const activation = departurePrompt.activation;
    setDeparturePrompt(null);
    sendPlaybackProgress(false);
    sendProgramActivation(activation, decision);
  }

  function cancelDeparture(): void {
    setDeparturePrompt(null);
  }

  function restoreActivationFocus(): void {
    window.requestAnimationFrame(() => activationTriggerRef.current?.focus());
  }

  function scheduleClockBurst(socket: WebSocket, sampleCount = 7) {
    if (sampleCount >= 7) clockSamplesRef.current = [];
    clockBurstTimersRef.current.forEach(window.clearTimeout);
    clockBurstTimersRef.current = Array.from(
      { length: sampleCount },
      (_, index) =>
        window.setTimeout(() => {
          if (socket.readyState !== WebSocket.OPEN) return;
          const clientSentAtMs = Date.now();
          socket.send(
            JSON.stringify(envelope(roomId, "clock.ping", { clientSentAtMs })),
          );
        }, index * 120),
    );
  }

  function reconcileVod(event: string) {
    const video = videoRef.current;
    const currentSnapshot = latestSnapshotRef.current;
    const transport = currentSnapshot?.transport;
    if (
      !video ||
      !transport ||
      !currentSnapshot.media ||
      currentSnapshot.mode !== "vod" ||
      video.dataset.mediaId !== currentSnapshot.media.id
    )
      return;
    const controller = getVodController();
    if (document.visibilityState === "hidden") controller.setVisible(false);
    if (!programEnabledRef.current) controller.setEnabled(false);
    controller.acceptSnapshot({
      revision: currentSnapshot.revision,
      mediaId: currentSnapshot.media.id,
      transport,
      ...(currentSnapshot.cause
        ? {
            commandId: currentSnapshot.cause.commandId,
            commandKind: currentSnapshot.cause.kind,
          }
        : {}),
    });
    controller.setVisible(document.visibilityState !== "hidden");
    controller.setEnabled(programEnabledRef.current);
    const events: Record<string, VodMediaEvent> = {
      "loaded-metadata": "loadedmetadata",
      "loaded-data": "loadeddata",
      seeking: "seeking",
      seeked: "seeked",
      waiting: "waiting",
      playing: "playing",
      error: "error",
    };
    const mediaEvent = events[event];
    if (mediaEvent) {
      recordPlayerEvent(`media-${mediaEvent}`);
      controller.notifyMediaEvent(mediaEvent);
    } else controller.tick();
    if (event !== "periodic") writeProgramDiagnostics(video, event);
  }

  async function enableVoice() {
    if (!roomCsrf || voiceState === "connecting") return;
    setVoiceState("connecting");
    setError("");
    try {
      // connect() and microphone permission remain in this click call chain so
      // browsers may resume audio playback without a separate hidden gesture.
      const credential = await api<{
        url: string;
        token: string;
      }>(`/api/v1/rooms/${roomId}/credentials`, {
        method: "POST",
        headers: { "x-csrf-token": roomCsrf },
        body: JSON.stringify({ purpose: "voice" }),
      });
      const { Room, RoomEvent, Track } = await import("livekit-client");
      const voiceRoom = new Room({ adaptiveStream: true, dynacast: true });
      voiceRoom.on(
        RoomEvent.TrackSubscribed,
        (track, _publication, participant) => {
          if (track.kind !== Track.Kind.Audio) return;
          const element = track.attach() as HTMLAudioElement;
          element.dataset.simplewatchVoice = "remote";
          element.dataset.participantId = participant.identity;
          element.volume = remoteVolume(participant.identity, preferences);
          voiceTracksRef.current?.append(element);
        },
      );
      voiceRoom.on(RoomEvent.TrackUnsubscribed, (track) => track.detach());
      voiceRoom.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        const video = videoRef.current;
        if (video && preferences.autoDuck)
          video.volume =
            (preferences.programVolume / 100) * (speakers.length ? 0.4 : 1);
      });
      voiceRoom.on(RoomEvent.Disconnected, () => {
        setVoiceState("idle");
        setMicrophoneEnabled(false);
      });
      await voiceRoom.connect(credential.url, credential.token, {
        autoSubscribe: true,
      });
      await voiceRoom.startAudio();
      voiceRoomRef.current = voiceRoom;
      try {
        await voiceRoom.localParticipant.setMicrophoneEnabled(
          true,
          preferences.inputDeviceId
            ? { deviceId: preferences.inputDeviceId }
            : undefined,
        );
        setMicrophoneEnabled(true);
      } catch {
        setMicrophoneEnabled(false);
        setError("麦克风未授权，已使用只听模式；节目播放不受影响");
      }
      setVoiceState("connected");
    } catch (voiceError) {
      void voiceRoomRef.current?.disconnect().catch(() => undefined);
      voiceRoomRef.current = null;
      setVoiceState("error");
      setError(
        voiceError instanceof Error ? voiceError.message : "语音连接失败",
      );
    }
  }

  async function enableLiveProgram() {
    if (
      !roomCsrf ||
      liveReaderRef.current ||
      liveConnectingRef.current ||
      liveRetryBlockedRef.current ||
      latestIsHostRef.current
    )
      return;
    const generation = ++liveReaderGenerationRef.current;
    liveConnectingRef.current = true;
    liveStateRef.current = "connecting";
    setLiveProgramState("connecting");
    try {
      const credential = await api<{ url: string; token: string }>(
        `/api/v1/rooms/${roomId}/credentials`,
        {
          method: "POST",
          headers: { "x-csrf-token": roomCsrf },
          body: JSON.stringify({ purpose: "whep" }),
        },
      );
      await import("../vendor/mediamtx-reader.js");
      if (generation !== liveReaderGenerationRef.current) return;
      const reader = new window.MediaMTXWebRTCReader({
        url: credential.url,
        user: "",
        pass: "",
        token: credential.token,
        autoRetry: false,
        onTrack: (event) => {
          if (generation !== liveReaderGenerationRef.current) {
            event.track.stop();
            return;
          }
          const video = videoRef.current;
          if (!video) return;
          const stream = liveStreamRef.current ?? new MediaStream();
          liveStreamRef.current = stream;
          const track = event.track;
          const kind = track.kind;
          if (kind !== "audio" && kind !== "video") {
            track.stop();
            return;
          }
          const existing = liveTracksRef.current.get(kind);
          const decision = decideProgramTrack(existing, track);
          if (decision === "same") return;
          if (decision === "reject-duplicate") {
            rejectedLiveTracksRef.current += 1;
            track.stop();
            writeProgramDiagnostics(video, "duplicate-live-track-rejected");
            return;
          }
          if (existing) stream.removeTrack(existing);
          liveTracksRef.current.set(kind, track);
          stream.addTrack(track);
          track.addEventListener(
            "ended",
            () => {
              if (
                generation !== liveReaderGenerationRef.current ||
                liveTracksRef.current.get(kind) !== track
              )
                return;
              liveTracksRef.current.delete(kind);
              if (latestSnapshotRef.current?.mode === "live")
                scheduleLiveRetry("直播轨道已结束，正在恢复连接");
            },
            { once: true },
          );
          const sourceChanged = video.srcObject !== stream;
          video.srcObject = stream;
          if (sourceChanged) startFrameObservation();
          video.volume = preferences.programVolume / 100;
          writeProgramDiagnostics(video, "live-track-added");
          if (
            stream.getAudioTracks().length !== 1 ||
            stream.getVideoTracks().length !== 1
          )
            return;
          void video
            .play()
            .then(() => {
              if (
                generation !== liveReaderGenerationRef.current ||
                video !== videoRef.current
              )
                return;
              if (typeof video.requestVideoFrameCallback !== "function") {
                liveStateRef.current = "playing";
                setLiveProgramState("playing");
              }
            })
            .catch((reason: unknown) => {
              if (
                generation !== liveReaderGenerationRef.current ||
                video !== videoRef.current
              )
                return;
              liveStateRef.current = "error";
              setLiveProgramState("error");
              setError(
                reason instanceof Error && reason.name === "NotSupportedError"
                  ? "当前设备无法播放直播编码；服务器不会转码"
                  : "浏览器未开始播放，请点击“启用节目声音”恢复",
              );
            });
        },
        onError: (readerError) => {
          if (generation === liveReaderGenerationRef.current)
            scheduleLiveRetry(`直播信号中断，正在重连：${readerError}`);
        },
      });
      if (generation === liveReaderGenerationRef.current)
        liveReaderRef.current = reader;
      else reader.close();
    } catch (readerError) {
      if (
        generation === liveReaderGenerationRef.current &&
        readerError instanceof ApiError &&
        [401, 403].includes(readerError.status)
      ) {
        closeLiveProgram();
        liveRetryBlockedRef.current = true;
        liveStateRef.current = "error";
        setLiveProgramState("error");
        setError("直播访问权限已失效，请返回门厅确认当前设备席位");
      } else if (generation === liveReaderGenerationRef.current)
        scheduleLiveRetry(
          readerError instanceof Error
            ? `直播连接失败，正在重试：${readerError.message}`
            : "直播连接失败，正在重试",
        );
    } finally {
      if (generation === liveReaderGenerationRef.current)
        liveConnectingRef.current = false;
    }
  }

  function scheduleLiveRetry(message: string, budgetConsumed = false) {
    closeLiveProgram();
    const retry =
      budgetConsumed || liveRecoveryRef.current.requestRetry(performance.now());
    liveRetryBlockedRef.current = !retry;
    liveStateRef.current = "error";
    setLiveProgramState("error");
    setError(
      retry ? message : "直播自动恢复已达到上限，请检查信号后手动重新连接",
    );
    recordPlayerEvent(retry ? "live-recovery" : "live-recovery-stopped");
    if (!retry) return;
    liveRetryTimerRef.current = replaceRetryTimer(
      liveRetryTimerRef.current,
      window.clearTimeout,
      window.setTimeout,
      () => {
        liveRetryTimerRef.current = 0;
        setLiveRetry((value) => value + 1);
      },
      2000,
    );
  }

  function closeLiveProgram() {
    if (frameModeRef.current === "live") {
      frameCancelRef.current?.();
      frameGenerationRef.current += 1;
      frameRef.current = null;
    }
    liveReaderGenerationRef.current += 1;
    liveConnectingRef.current = false;
    liveHasFrameRef.current = false;
    liveStateRef.current = "idle";
    window.clearTimeout(liveRetryTimerRef.current);
    liveRetryTimerRef.current = 0;
    liveReaderRef.current?.close();
    liveReaderRef.current = null;
    liveStreamRef.current?.getTracks().forEach((track) => track.stop());
    liveStreamRef.current = null;
    liveTracksRef.current.clear();
    liveSamplerRef.current.reset();
    liveStatsRef.current = null;
    setLiveStats(null);
    if (videoRef.current?.srcObject) videoRef.current.srcObject = null;
    setLiveProgramState("idle");
  }

  async function collectLiveStats() {
    const peer = liveReaderRef.current?.getPeerConnection();
    const generation = liveReaderGenerationRef.current;
    if (
      !peer ||
      latestSnapshotRef.current?.mode !== "live" ||
      document.visibilityState === "hidden"
    )
      return;
    const sample = await liveSamplerRef.current.sample(peer, {
      generation,
      atMs: performance.now(),
      renderedFrames: frameRef.current?.presentedFrames ?? null,
    });
    if (
      !sample ||
      generation !== liveReaderGenerationRef.current ||
      !mountedRef.current ||
      document.hidden
    )
      return;
    liveStatsRef.current = sample;
    setLiveStats(sample);
    try {
      sessionStorage.setItem(
        "simplewatch.live-diagnostics",
        JSON.stringify({ updatedAt: new Date().toISOString(), ...sample }),
      );
    } catch {
      /* Optional diagnostics cannot interrupt a stream. */
    }
    if (
      liveRecoveryRef.current.shouldRecover({
        generation,
        atMs: performance.now(),
        foreground: !document.hidden,
        enabled: programEnabledRef.current,
        started: liveHasFrameRef.current,
        videoBytesReceived: sample.videoBytesReceived,
        renderedFrames: frameRef.current?.presentedFrames ?? null,
      })
    )
      scheduleLiveRetry("持续收包但画面没有推进，正在恢复节目", true);
  }

  async function enableProgramSound() {
    programEnabledRef.current = true;
    setProgramEnabled(true);
    setError("");
    const video = videoRef.current;
    if (video) {
      video.muted = false;
      video.volume = preferences.programVolume / 100;
      if (latestSnapshotRef.current?.mode === "vod") {
        reconcileVod("user-enable");
        getVodController().userPlay();
      } else if (
        latestSnapshotRef.current?.mode === "live" &&
        video.srcObject
      ) {
        // Invoke play in this gesture even when a Reader already exists.
        const generation = liveReaderGenerationRef.current;
        try {
          await video.play();
          if (
            generation === liveReaderGenerationRef.current &&
            typeof video.requestVideoFrameCallback !== "function"
          ) {
            liveStateRef.current = "playing";
            setLiveProgramState("playing");
          }
        } catch {
          if (generation === liveReaderGenerationRef.current)
            setError("请允许浏览器播放节目声音后再次点击恢复");
        }
      }
    }
    if (
      !isHost &&
      snapshot?.mode === "live" &&
      liveStatus.data?.state === "online"
    ) {
      await enableLiveProgram();
    }
  }

  async function toggleVodPlayback() {
    if (!isHost || getCommandQueue().getPendingIds().length > 0) return;
    if (!programEnabled) await enableProgramSound();
    const current = latestSnapshotRef.current;
    if (
      current?.mode !== "vod" ||
      !current.transport ||
      getCommandQueue().getPendingIds().length > 0
    )
      return;
    if (current.transport.state === "playing") sendPlaybackProgress(false);
    command({
      kind: current.transport.state === "playing" ? "pause" : "play",
    });
  }

  function commitSeek(positionSec: number) {
    if (!isHost || !durationSec) return;
    const next = clamp(positionSec, 0, durationSec);
    setSeekDraftSec(null);
    seekDraftRef.current = null;
    const commandId = command({ kind: "seek", positionSec: next });
    if (commandId && getCommandQueue().getPendingIds().includes(commandId)) {
      // Keep the submitted target until it is acknowledged and presented.
      // Otherwise the next key/drag starts from the old, not-yet-seeked frame.
      pendingSeekRef.current = { commandId };
      setPendingSeekSec(next);
    }
  }

  function reloadVodProgram() {
    const video = videoRef.current;
    if (!video) return;
    setSyncFailed(false);
    setError("");
    refreshRoomSnapshot();
    if (video.error) {
      frameRef.current = null;
      video.load();
    }
    getVodController().retry();
    getVodController().userPlay();
  }

  function updateProgramMetrics(video: HTMLVideoElement, event: string) {
    setPlayheadSec(video.currentTime);
    const buffered = bufferedAhead(video);
    setBufferedAheadSec(buffered);
    writeProgramDiagnostics(video, event, buffered);
  }

  function writeProgramDiagnostics(
    video: HTMLVideoElement,
    event: string,
    buffered = bufferedAhead(video),
  ) {
    try {
      const quality = video.getVideoPlaybackQuality?.();
      sessionStorage.setItem(
        "simplewatch.program-diagnostics",
        JSON.stringify({
          updatedAt: new Date().toISOString(),
          event,
          mode: snapshot?.mode ?? "idle",
          codec: media.data?.video.codec ?? null,
          resolution:
            media.data?.video.width && media.data.video.height
              ? `${media.data.video.width}x${media.data.video.height}`
              : null,
          averageBitrateMbps: round(bitrateMbps, 1),
          currentTimeSec: round(video.currentTime, 2),
          durationSec: round(video.duration || durationSec, 2),
          bufferedAheadSec: round(buffered, 2),
          readyState: video.readyState,
          networkState: video.networkState,
          stalls: stallCountRef.current,
          droppedFrames: quality?.droppedVideoFrames ?? null,
          totalFrames: quality?.totalVideoFrames ?? null,
          liveAudioTracks: liveStreamRef.current?.getAudioTracks().length ?? 0,
          liveVideoTracks: liveStreamRef.current?.getVideoTracks().length ?? 0,
          rejectedLiveTracks: rejectedLiveTracksRef.current,
          syncDeltaMs,
          clockRttMs,
          serverAudioTracks: liveStatus.data?.audioTrackCount ?? null,
          serverVideoTracks: liveStatus.data?.videoTrackCount ?? null,
          readerGeneration: liveReaderGenerationRef.current,
        }),
      );
    } catch {
      // Optional diagnostics must never interrupt media events or play().
    }
  }

  async function toggleMicrophone() {
    const room = voiceRoomRef.current;
    if (!room) return;
    const next = !microphoneEnabled;
    await room.localParticipant.setMicrophoneEnabled(next);
    setMicrophoneEnabled(next);
  }

  async function removeMember(targetMemberId: string) {
    if (!roomCsrf || !confirm("确认移出这位成员？对方将立即断开。")) return;
    const result = await api<RoomSnapshot>(
      `/api/v1/rooms/${roomId}/members/${targetMemberId}/kick`,
      {
        method: "POST",
        headers: { "x-csrf-token": roomCsrf },
        body: JSON.stringify({ reason: "host_removed" }),
      },
    );
    acceptRoomSnapshot(result);
  }

  async function requestPublishConfig() {
    setPublishConfigError("");
    try {
      const result = await api<{ url: string; token: string }>(
        `/api/v1/rooms/${roomId}/live/publish-config`,
        { method: "GET" },
      );
      setPublishConfig(result);
    } catch (reason) {
      setPublishConfigError(
        reason instanceof Error ? reason.message : "OBS 配置获取失败",
      );
    }
  }

  async function rotatePublishConfig() {
    if (!adminCsrf) return;
    const confirmation = prompt(
      "这会让正在使用旧配置的 OBS 立即断开。输入“重新生成OBS配置”确认。",
    );
    if (confirmation !== "重新生成OBS配置") return;
    const result = await api<{ url: string; token: string }>(
      "/api/v1/admin/obs-credentials/rotate",
      {
        method: "POST",
        headers: { "x-csrf-token": adminCsrf },
        body: JSON.stringify({ confirmation }),
      },
    );
    setPublishConfig(result);
  }

  async function leaveRoom() {
    if (!roomCsrf || !confirm("确认离开放映室？")) return;
    await api<void>(`/api/v1/rooms/${roomId}/leave`, {
      method: "POST",
      headers: { "x-csrf-token": roomCsrf },
    });
    closeLiveProgram();
    await voiceRoomRef.current?.disconnect();
    setMemberId(null);
    void navigate("/", { replace: true });
  }

  async function closeRoom() {
    if (!roomCsrf || !confirm("确认关闭放映室？所有成员会立即退出。")) return;
    closingRoomRef.current = true;
    try {
      await api<void>(`/api/v1/rooms/${roomId}`, {
        method: "DELETE",
        headers: { "x-csrf-token": roomCsrf },
      });
      closeLiveProgram();
      await voiceRoomRef.current?.disconnect();
      void navigate("/admin", { replace: true });
    } catch (closeError) {
      closingRoomRef.current = false;
      setError(
        closeError instanceof Error ? closeError.message : "关闭房间失败",
      );
    }
  }

  async function toggleFullscreen() {
    const screen = screenRef.current;
    if (!screen) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await screen.requestFullscreen();
  }

  function reconnectLiveProgram() {
    closeLiveProgram();
    liveRetryBlockedRef.current = false;
    programEnabledRef.current = true;
    setProgramEnabled(true);
    setLiveRetry((value) => value + 1);
  }

  function setParticipantVolume(id: string, value: number) {
    const next = {
      ...preferences,
      participantVolumes: { ...preferences.participantVolumes, [id]: value },
    };
    setPreferences(next);
    voiceTracksRef.current
      ?.querySelectorAll<HTMLAudioElement>(
        `audio[data-participant-id="${CSS.escape(id)}"]`,
      )
      .forEach((element) => {
        element.volume = remoteVolume(id, next);
      });
  }

  if (!joined)
    return (
      <main className="room-shell join-room-shell">
        <Link to="/" className="brand-mark">
          SW / 门厅
        </Link>
        <section className="admission-card">
          <p className="eyebrow">SESSION REQUIRED</p>
          <h1>这张入场券已经失效。</h1>
          <p className="muted-copy">
            请返回门厅。若席位已在另一台设备使用，可以选择在本设备接管。
          </p>
          <output>{error}</output>
        </section>
      </main>
    );

  return (
    <main className={`room-shell${theaterMode ? " theater-mode" : ""}`}>
      <header className="room-header">
        <Link to="/" className="brand-mark">
          SIMPLEWATCH
        </Link>
        <div className="room-code">
          ROOM <strong>{roomId.slice(0, 8)}</strong>
        </div>
        <span className={`signal ${connected ? "online" : ""}`}>
          {connected ? "同步在线" : "正在重连"}
        </span>
        <nav className="room-links">
          {isHost && <Link to="/admin">返回放映控制</Link>}
          <Link to="/settings">设置</Link>
          <Link to="/diagnostics">诊断</Link>
          {isHost ? (
            <button
              type="button"
              className="text-button danger"
              onClick={() => void closeRoom()}
            >
              关闭房间
            </button>
          ) : (
            <button
              type="button"
              className="text-button"
              onClick={() => void leaveRoom()}
            >
              退出房间
            </button>
          )}
        </nav>
      </header>
      <div className="screen-layout">
        <section className="screen-frame" ref={screenRef}>
          <div className="screen-meta">
            <span>
              {snapshot?.mode === "vod"
                ? "VOD PROGRAM"
                : snapshot?.mode === "live"
                  ? `LIVE / ${liveLabel(liveStatus.data?.state)}`
                  : "WAITING FOR REEL"}
            </span>
            <span>REV {snapshot?.revision ?? 0}</span>
            {snapshot?.mode === "vod" && (
              <span>
                SYNC {syncDeltaMs === null ? "—" : `${syncDeltaMs} ms`} · RTT{" "}
                {clockRttMs === null ? "—" : `${clockRttMs} ms`}
              </span>
            )}
          </div>
          {syncFailed && snapshot?.mode === "vod" && (
            <div className="program-warning" role="alert">
              <strong>本机同步暂未收敛</strong>
              <span>
                自动定位已停止，避免反复跳转。请检查网络或媒体错误后重试。
              </span>
              <button type="button" onClick={() => reloadVodProgram()}>
                重新同步节目
              </button>
            </div>
          )}
          {media.data?.video.codec === "hevc" && !supportsHevcPlayback() && (
            <div className="program-warning" role="status">
              这条影片使用
              H.265。当前浏览器未声明支持，仍可尝试播放；若出现黑屏或解码错误，请换用支持
              H.265 的 Safari、Edge 或设备。
            </div>
          )}
          {snapshot?.mode === "vod" && highLoadVod && media.data && (
            <div className="program-warning high-load-warning" role="status">
              <strong>高负载原片</strong>
              <span>
                {media.data.video.width ?? "?"}×{media.data.video.height ?? "?"}{" "}
                · {bitrateMbps.toFixed(1)}
                Mbps / 播放端
              </span>
              <span>
                当前 {onlinePlaybackEndpoints} 个在线端理论聚合约{" "}
                {aggregateBitrateMbps.toFixed(1)}{" "}
                Mbps。服务器不会转码；若主持端卡顿而其他端流畅，通常是该终端的网络或
                {media.data.video.codec === "hevc" ? " H.265 硬件解码" : "解码"}
                能力不足。
              </span>
            </div>
          )}
          {snapshot?.mode === "live" && !isHost ? (
            <video
              key="live-program"
              ref={videoRef}
              controls={false}
              playsInline
            />
          ) : snapshot?.mode === "live" && isHost ? (
            <div className="live-director-view">
              <p className="eyebrow">LIVE CONTROL / OBS</p>
              <h2>{liveLabel(liveStatus.data?.state)}</h2>
              <p>
                直播节目只发送给观看者。放映者在此只保留播控与语音，避免回传节目音频造成重复。
              </p>
              <p className="live-track-status">
                节目轨道：视频 {liveStatus.data?.videoTrackCount ?? 0} / 音频{" "}
                {liveStatus.data?.audioTrackCount ?? 0}
              </p>
              <p className="live-track-status">
                OBS 上行：
                {liveStatus.data?.sourceBitrateMbps?.toFixed(2) ?? "—"} Mbps ·
                丢包{" "}
                {liveStatus.data?.sourcePacketLossPercent?.toFixed(2) ?? "—"}%
              </p>
              {liveStatus.data?.state === "online" &&
                liveStatus.data.audioTrackCount !== 1 && (
                  <p className="program-warning">
                    直播应当只有 1 条 Opus 音轨。请先停止推流并检查 OBS
                    音频来源。
                  </p>
                )}
              <button
                disabled={!hostControlsReady}
                onClick={() => command({ kind: "restore-vod" })}
              >
                返回服务器影片
              </button>
            </div>
          ) : snapshot?.media ? (
            <video
              key={snapshot.media.id}
              ref={videoRef}
              data-media-id={snapshot.media.id}
              src={`/api/v1/media/${snapshot.media.id}/content`}
              controls={false}
              playsInline
              preload="auto"
              onLoadedMetadata={(event) => {
                updateProgramMetrics(event.currentTarget, "loaded-metadata");
                reconcileVod("loaded-metadata");
              }}
              onCanPlay={() => reconcileVod("can-play")}
              onLoadedData={() => reconcileVod("loaded-data")}
              onSeeking={() => reconcileVod("seeking")}
              onSeeked={() => reconcileVod("seeked")}
              onTimeUpdate={(event) =>
                updateProgramMetrics(event.currentTarget, "time-update")
              }
              onProgress={(event) =>
                updateProgramMetrics(event.currentTarget, "progress")
              }
              onPlaying={(event) => {
                updateProgramMetrics(event.currentTarget, "playing");
                reconcileVod("playing");
              }}
              onPause={(event) => {
                updateProgramMetrics(event.currentTarget, "pause");
                sendPlaybackProgress(false);
              }}
              onEnded={(event) => {
                updateProgramMetrics(event.currentTarget, "ended");
                sendPlaybackProgress(false);
              }}
              onWaiting={(event) => {
                stallCountRef.current += 1;
                updateProgramMetrics(event.currentTarget, "waiting");
                reconcileVod("waiting");
              }}
              onError={(event) => {
                updateProgramMetrics(event.currentTarget, "error");
                reconcileVod("error");
                setError(
                  mediaErrorMessage(
                    event.currentTarget.error?.code ?? null,
                    media.data?.video.codec,
                  ),
                );
              }}
            >
              {media.data?.subtitles.map((subtitle) => (
                <track
                  key={subtitle.id}
                  kind="subtitles"
                  src={`/api/v1/subtitles/${subtitle.id}`}
                  srcLang={subtitle.language}
                  label={subtitle.label}
                />
              ))}
            </video>
          ) : (
            <div className="blank-screen">
              <i />
              <p>等待主持人装片</p>
            </div>
          )}
          {snapshot?.mode === "live" && !isHost && (
            <div
              className={`live-quality quality-${liveStats?.health ?? "unknown"}`}
              role="status"
            >
              <strong>{viewerHealthLabel(liveStats?.health)}</strong>
              <span>接收 {liveStats?.bitrateMbps?.toFixed(2) ?? "—"} Mbps</span>
              <span>
                呈现 {liveStats?.renderedFramesPerSecond?.toFixed(0) ?? "—"} fps
                · 解码 {liveStats?.decodedFramesPerSecond?.toFixed(0) ?? "—"}{" "}
                fps
              </span>
              <span>
                丢包 {liveStats?.packetLossPercent?.toFixed(2) ?? "—"}%
              </span>
              <span>
                RTT {liveStats?.rttMs?.toFixed(0) ?? "—"} ms · 抖动缓冲{" "}
                {liveStats?.jitterBufferMs?.toFixed(0) ?? "—"}{" "}
                ms（非端到端延迟）
              </span>
              <span>{liveStats?.protocol ?? "—"}</span>
              {liveQualityExplanation(liveStatus.data, liveStats) && (
                <small>
                  {liveQualityExplanation(liveStatus.data, liveStats)}
                </small>
              )}
            </div>
          )}
          {snapshot?.mode === "vod" && (
            <div className="transport-bar">
              <button
                disabled={!hostControlsReady || pendingCommandCount > 0}
                onClick={() => void toggleVodPlayback()}
              >
                {snapshot?.transport?.state === "playing" ? "Ⅱ 暂停" : "▶ 播放"}
              </button>
              <button
                disabled={!hostControlsReady}
                onClick={() => commitSeek(displayedPositionSec - 10)}
              >
                −10s
              </button>
              <button
                disabled={!hostControlsReady}
                onClick={() => commitSeek(displayedPositionSec + 10)}
              >
                +10s
              </button>
              <div className="playback-scrubber">
                <input
                  key={`${roomId}:${snapshot?.mode}:${snapshot?.media?.id ?? "none"}`}
                  aria-label="播放进度"
                  type="range"
                  min="0"
                  max={Math.max(durationSec, 0.1)}
                  step="0.1"
                  disabled={!hostControlsReady || durationSec <= 0}
                  value={displayedPositionSec}
                  style={
                    {
                      "--playhead-percent": `${durationSec ? (displayedPositionSec / durationSec) * 100 : 0}%`,
                      "--buffered-percent": `${durationSec ? (Math.min(durationSec, playheadSec + bufferedAheadSec) / durationSec) * 100 : 0}%`,
                    } as CSSProperties
                  }
                  onPointerDown={(event) => {
                    seekingRef.current = true;
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }}
                  onChange={(event) => {
                    seekDraftRef.current = Number(event.currentTarget.value);
                    setSeekDraftSec(seekDraftRef.current);
                  }}
                  onPointerUp={(event) => {
                    if (!seekingRef.current && seekDraftRef.current === null)
                      return;
                    seekingRef.current = false;
                    if (event.currentTarget.hasPointerCapture(event.pointerId))
                      event.currentTarget.releasePointerCapture(
                        event.pointerId,
                      );
                    commitSeek(Number(event.currentTarget.value));
                  }}
                  onPointerCancel={() => {
                    seekingRef.current = false;
                    seekDraftRef.current = null;
                    setSeekDraftSec(null);
                  }}
                  onKeyUp={(event) => {
                    if (
                      [
                        "ArrowLeft",
                        "ArrowRight",
                        "Home",
                        "End",
                        "PageUp",
                        "PageDown",
                      ].includes(event.key) &&
                      seekDraftRef.current !== null
                    )
                      commitSeek(Number(event.currentTarget.value));
                  }}
                  onBlur={(event) => {
                    if (seekDraftRef.current === null) return;
                    seekingRef.current = false;
                    commitSeek(Number(event.currentTarget.value));
                  }}
                />
                <output aria-live="off">
                  {formatMediaTime(displayedPositionSec)} /{" "}
                  {formatMediaTime(durationSec)}
                </output>
              </div>
              <select
                disabled={!hostControlsReady}
                aria-label="播放速度"
                value={snapshot?.transport?.rate ?? 1}
                onChange={(event) =>
                  command({
                    kind: "set-rate",
                    rate: Number(event.target.value),
                  })
                }
              >
                {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                  <option key={rate} value={rate}>
                    {rate}×
                  </option>
                ))}
              </select>
            </div>
          )}
          {(snapshot?.mode === "vod" ||
            (snapshot?.mode === "live" && !isHost)) && (
            <div className="program-view-controls">
              <button type="button" onClick={() => void toggleFullscreen()}>
                屏幕全屏
              </button>
              <button
                type="button"
                onClick={() => setTheaterMode((value) => !value)}
              >
                {theaterMode ? "退出网页全屏" : "网页全屏"}
              </button>
              {snapshot?.mode === "live" && (
                <button type="button" onClick={() => reconnectLiveProgram()}>
                  重新连接节目
                </button>
              )}
            </div>
          )}
          {snapshot?.mode === "vod" && (
            <div className="program-warning" role="status">
              <span>{vodPhaseLabel(vodStatus?.phase)}</span>
              {vodStatus?.frameEvidence === "unavailable" && (
                <small>此浏览器未提供逐帧证据，同步状态需结合画面确认。</small>
              )}
              {isHost && commandState && <span>{commandState}</span>}
              {vodStatus?.phase === "autoplay-blocked" && (
                <button type="button" onClick={() => void enableProgramSound()}>
                  点击恢复播放
                </button>
              )}
            </div>
          )}
          <details className="playback-diagnostics">
            <summary>播放诊断</summary>
            <p>
              房间版本 {snapshot?.revision ?? "—"} · 目标{" "}
              {vodStatus?.targetSec?.toFixed(2) ?? "—"}s · 最近呈现{" "}
              {vodStatus?.presentedTimeSec?.toFixed(2) ?? "—"}s · 定位尝试{" "}
              {vodStatus?.seekAttempts ?? 0}
            </p>
            <p>服务端确认只表示操作已接受，画面是否完成同步以各观看端为准。</p>
            {isHost &&
              playbackReports?.reports.map(
                ({ memberId: id, nickname, report }) => (
                  <p key={id}>
                    {nickname} · REV {report.revision} · {report.state} ·{" "}
                    {report.positionSec?.toFixed(2) ?? "—"}s · 呈现{" "}
                    {report.fps?.toFixed(0) ?? "—"}fps
                  </p>
                ),
              )}
          </details>
          <div className="local-mix">
            {(!isHost || snapshot?.mode === "vod") && (
              <button
                type="button"
                className={
                  programEnabled
                    ? "secondary-button active"
                    : "secondary-button"
                }
                onClick={() => void enableProgramSound()}
              >
                {programEnabled
                  ? vodStatus?.phase === "autoplay-blocked" ||
                    (snapshot?.mode === "live" && liveProgramState === "error")
                    ? "点击恢复节目"
                    : snapshot?.mode === "live" &&
                        liveProgramState === "connecting"
                      ? "节目连接中…"
                      : "节目声音已启用"
                  : "启用节目声音"}
              </button>
            )}
            <label>
              节目音量{" "}
              <input
                aria-label="节目音量"
                type="range"
                min="0"
                max="100"
                value={preferences.programVolume}
                onChange={(event) =>
                  setPreferences({
                    ...preferences,
                    programVolume: Number(event.target.value),
                  })
                }
              />
            </label>
            <label>
              通话音量{" "}
              <input
                aria-label="通话音量"
                type="range"
                min="0"
                max="100"
                value={preferences.callVolume}
                onChange={(event) =>
                  setPreferences({
                    ...preferences,
                    callVolume: Number(event.target.value),
                  })
                }
              />
            </label>
          </div>
          {isHost && (
            <HostProgramQueue
              program={program.data}
              transfers={edgeTransfers.data ?? []}
              loading={program.isLoading}
              error={program.error ?? edgeTransfers.error}
              pendingItemId={pendingProgramItemId}
              onActivate={activateProgramItem}
            />
          )}
          {isHost && (
            <section className="host-controls">
              <strong>主持控制</strong>
              <select
                aria-label="选择点播影片"
                disabled={!hostControlsReady}
                value={
                  snapshot?.mode === "vod" ? (snapshot.media?.id ?? "") : ""
                }
                onChange={(event) =>
                  event.target.value &&
                  command({ kind: "select-vod", mediaId: event.target.value })
                }
              >
                <option value="">选择片库影片</option>
                {library.data
                  ?.filter(
                    (item) =>
                      item.state === "published" &&
                      !programMediaIds.has(item.id),
                  )
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.displayName}
                    </option>
                  ))}
              </select>
              {snapshot?.mode === "live" ? (
                <button
                  disabled={!hostControlsReady}
                  onClick={() => command({ kind: "restore-vod" })}
                >
                  返回服务器影片
                </button>
              ) : (
                <button
                  disabled={!hostControlsReady}
                  onClick={() => command({ kind: "select-live" })}
                >
                  切换直播
                </button>
              )}
              {snapshot?.mode === "live" && !publishConfig && (
                <div className="publish-config-loading" role="status">
                  <span>
                    {publishConfigError
                      ? `OBS 配置暂不可用：${publishConfigError}`
                      : "正在载入长期 OBS 配置…"}
                  </span>
                  {publishConfigError && (
                    <button onClick={() => void requestPublishConfig()}>
                      重新获取显示
                    </button>
                  )}
                </div>
              )}
              {snapshot?.mode === "live" && publishConfig && (
                <div className="publish-config">
                  <div className="obs-preset">
                    <strong>OBS 推荐参数</strong>
                    <span>1920×1080 · 30 fps · H.264 硬件编码</span>
                    <span>CBR 3000 Kbps（链路持续绿色后升至 4000–6000）</span>
                    <span>
                      Main Profile · 关键帧间隔 1 秒 · B 帧 0 · Opus 48 kHz
                      立体声 128 Kbps
                    </span>
                  </div>
                  <div className="obs-audio-checklist" role="note">
                    <strong>推流前音频自检（避免重声）</strong>
                    <span>
                      同一系统声音只能保留一个来源：屏幕采集音频或桌面音频，二选一。
                    </span>
                    <span>
                      macOS 屏幕采集若已带声音，请禁用全局“桌面音频”。
                    </span>
                    <span>
                      高级音频属性中的“音频监听”设为“仅输出/监听关闭”，不要“监听并输出”。
                    </span>
                    <span>
                      先在 OBS 本地录制 10
                      秒试听；本地已重声时，服务器无法从单条 Opus
                      音轨中分离修复。
                    </span>
                  </div>
                  <code>{publishConfig.url}</code>
                  <code>{publishConfig.token}</code>
                  <button
                    onClick={() =>
                      void navigator.clipboard.writeText(
                        `${publishConfig.url}\n${publishConfig.token}`,
                      )
                    }
                  >
                    复制
                  </button>
                  <button
                    type="button"
                    className="text-button danger"
                    onClick={() => void rotatePublishConfig()}
                  >
                    重新生成 OBS 配置
                  </button>
                </div>
              )}
            </section>
          )}
        </section>
        <aside className="audience-panel">
          <div className="panel-title">
            <span>SEATS</span>
            <h2>同场观众</h2>
          </div>
          <ol className="seat-list">
            {snapshot?.members.map((member, index) => (
              <li key={member.id}>
                <b>{String(index + 1).padStart(2, "0")}</b>
                <span>
                  {member.nickname}
                  <small>{member.role === "host" ? "放映主持" : "观众"}</small>
                </span>
                <i className={member.online ? "present" : ""} />
                {voiceState === "connected" && member.id !== memberId && (
                  <input
                    aria-label={`${member.nickname} 通话音量`}
                    type="range"
                    min="0"
                    max="100"
                    value={preferences.participantVolumes[member.id] ?? 100}
                    onChange={(event) =>
                      setParticipantVolume(
                        member.id,
                        Number(event.target.value),
                      )
                    }
                  />
                )}
                {isHost && member.id !== memberId && (
                  <span className="member-actions">
                    <button onClick={() => void removeMember(member.id)}>
                      移出
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ol>
          <div className="voice-card">
            <span>VOICE CHANNEL</span>
            <strong>
              {voiceState === "connected"
                ? microphoneEnabled
                  ? "麦克风已接通"
                  : "只听模式"
                : voiceState === "connecting"
                  ? "正在建立安全通道"
                  : voiceState === "error"
                    ? "语音暂不可用"
                    : "尚未进入语音席"}
            </strong>
            {voiceState === "connected" ? (
              <button onClick={() => void toggleMicrophone()}>
                {microphoneEnabled ? "静音" : "打开麦克风"}
              </button>
            ) : (
              <button
                disabled={voiceState === "connecting"}
                onClick={() => void enableVoice()}
              >
                加入语音通话
              </button>
            )}
            <div ref={voiceTracksRef} hidden aria-hidden="true" />
          </div>
          {error && <output className="room-error">{error}</output>}
        </aside>
      </div>
      <DepartureDecisionDialog
        open={Boolean(departurePrompt)}
        currentTitle={snapshot?.media?.title ?? ""}
        targetTitle={departurePrompt?.activation.displayName ?? ""}
        coveredRatio={departurePrompt?.coveredRatio ?? null}
        returnFocus={activationTriggerRef.current}
        onDecision={decideDeparture}
        onCancel={cancelDeparture}
      />
      <footer className="room-footer">
        <span>CSRF {roomCsrf ? "ARMED" : "MISSING"}</span>
        <span>同步锚点 {snapshot?.transport?.anchoredAtServerMs ?? "—"}</span>
      </footer>
    </main>
  );
}

function remoteVolume(
  participantId: string,
  preferences: ReturnType<typeof loadPreferences>,
) {
  return (
    (preferences.callVolume / 100) *
    ((preferences.participantVolumes[participantId] ?? 100) / 100)
  );
}

function envelope(roomId: string, type: string, payload: unknown) {
  return { v: 1, type, id: uuidv7(), roomId, sentAtMs: Date.now(), payload };
}

function supportsHevcPlayback(): boolean {
  if (typeof document === "undefined") return false;
  const video = document.createElement("video");
  return Boolean(
    video.canPlayType('video/mp4; codecs="hvc1"') ||
    video.canPlayType('video/mp4; codecs="hev1"'),
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(Math.max(value, minimum), maximum);
}

function finiteSeconds(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function bufferedAhead(video: HTMLVideoElement): number {
  for (let index = 0; index < video.buffered.length; index += 1) {
    if (
      video.buffered.start(index) <= video.currentTime &&
      video.buffered.end(index) >= video.currentTime
    )
      return Math.max(0, video.buffered.end(index) - video.currentTime);
  }
  return 0;
}

function round(value: number, digits: number): number {
  if (!Number.isFinite(value)) return 0;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function formatMediaTime(value: number): string {
  const seconds = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function liveLabel(state: LiveStatus["state"] | undefined): string {
  return state === "online"
    ? "信号在线"
    : state === "offline"
      ? "等待 OBS"
      : state === "unknown"
        ? "状态未知"
        : "正在检查";
}

function viewerHealthLabel(
  health: LiveViewerStats["health"] | undefined,
): string {
  return health === "good"
    ? "链路良好"
    : health === "degraded"
      ? "链路波动"
      : health === "poor"
        ? "链路较差"
        : "正在测量";
}

export function liveQualityExplanation(
  source: LiveStatus | undefined,
  viewer: LiveViewerStats | null,
): string {
  if (source?.sourceHealth === "poor" || source?.sourceHealth === "degraded")
    return "OBS 到服务器的上行指标显示波动，请结合实际编码输出和网络记录核对。";
  if (
    viewer?.packetLossPercent !== null &&
    viewer?.packetLossPercent !== undefined &&
    viewer.packetLossPercent > 1
  )
    return "当前观看端下行丢包较高；源端编码与上传情况仍需独立核对。";
  if (
    viewer?.renderedFramesPerSecond === 0 &&
    (viewer.decodedFramesPerSecond ?? 0) > 0
  )
    return "已解码但画面没有推进，请核对解码或渲染链路与浏览器播放状态。";
  if (
    !viewer ||
    viewer.health === "unknown" ||
    !source ||
    source.sourceHealth === "unknown"
  )
    return "指标不足，尚不能判断卡顿环节；缺失值不代表正常。";
  return "";
}
