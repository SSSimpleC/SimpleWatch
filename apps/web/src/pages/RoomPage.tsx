import { useQuery } from "@tanstack/react-query";
import {
  decideDriftCorrection,
  estimateClock,
  selectStableClockEstimate,
  type ClockEstimate,
} from "@simplewatch/sync";
import type { Room as LiveKitRoom } from "livekit-client";
import { v7 as uuidv7 } from "uuid";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import {
  api,
  type LiveStatus,
  type MediaItem,
  type RoomSnapshot,
} from "../api.js";
import { decideProgramTrack, replaceRetryTimer } from "../live-program.js";
import { averageBitrateMbps, isHighLoadVod } from "../media-performance.js";
import { loadPreferences, savePreferences } from "../preferences.js";
import { useSession } from "../store.js";

export function RoomPage() {
  const { roomId = "" } = useParams();
  const navigate = useNavigate();
  const { adminCsrf, roomCsrf, setRoomCsrf, memberId, setMemberId } =
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
  const previousLiveStatsRef = useRef<LiveStatsSample | null>(null);
  const stallCountRef = useRef(0);
  const seekingRef = useRef(false);
  const clockOffsetMsRef = useRef<number | null>(null);
  const clockSamplesRef = useRef<ClockEstimate[]>([]);
  const clockBurstTimersRef = useRef<number[]>([]);
  const excessiveDriftSinceRef = useRef<number | null>(null);
  const closingRoomRef = useRef(false);
  const latestSnapshotRef = useRef<RoomSnapshot | null>(null);
  const programEnabledRef = useRef(false);
  const [programEnabled, setProgramEnabled] = useState(false);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [bufferedAheadSec, setBufferedAheadSec] = useState(0);
  const [syncDeltaMs, setSyncDeltaMs] = useState<number | null>(null);
  const [clockRttMs, setClockRttMs] = useState<number | null>(null);
  const [syncFailed, setSyncFailed] = useState(false);
  const [seekDraftSec, setSeekDraftSec] = useState<number | null>(null);
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
  const isHost = Boolean(snapshot && memberId === snapshot.hostMemberId);
  const media = useQuery({
    queryKey: ["room-media", snapshot?.media?.id],
    queryFn: () => api<MediaItem>(`/api/v1/media/${snapshot?.media?.id ?? ""}`),
    enabled: Boolean(snapshot?.media?.id),
  });
  const library = useQuery({
    queryKey: ["media"],
    queryFn: () => api<MediaItem[]>("/api/v1/media"),
    enabled: isHost && Boolean(adminCsrf),
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
    seekDraftSec ?? playheadSec,
    0,
    durationSec,
  );
  const bitrateMbps = averageBitrateMbps(media.data);
  const onlinePlaybackEndpoints =
    snapshot?.members.filter((member) => member.online).length ?? 0;
  const aggregateBitrateMbps = bitrateMbps * onlinePlaybackEndpoints;
  const highLoadVod = isHighLoadVod(media.data);

  latestSnapshotRef.current = snapshot;
  programEnabledRef.current = programEnabled;

  useEffect(() => {
    let active = true;
    void api<{ snapshot: RoomSnapshot; memberId: string; csrfToken: string }>(
      `/api/v1/rooms/${roomId}/bootstrap`,
    )
      .then((bootstrap) => {
        if (!active) return;
        setRoomCsrf(bootstrap.csrfToken);
        setMemberId(bootstrap.memberId);
        setSnapshot(bootstrap.snapshot);
        clockOffsetMsRef.current = bootstrap.snapshot.serverNowMs - Date.now();
        setJoined(true);
      })
      .catch(() => setError("房间会话已失效，请重新打开好友链接"));
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
    setSeekDraftSec(null);
    setPlayheadSec(0);
    setBufferedAheadSec(0);
    stallCountRef.current = 0;
  }, [snapshot?.media?.id]);

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
      const socket = new WebSocket(
        `${protocol}//${location.host}/api/v1/rooms/${roomId}/ws`,
        "simplewatch.v1",
      );
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        retryAttempt = 0;
        setConnected(true);
        socket.send(JSON.stringify(envelope(roomId, "room.hello", {})));
        scheduleClockBurst(socket);
      });
      socket.addEventListener("close", (event) => {
        setConnected(false);
        if (disposed) return;
        if ([4001, 4003, 4010].includes(event.code)) {
          closeLiveProgram();
          voiceRoomRef.current?.disconnect();
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
        const message = JSON.parse(String(event.data)) as {
          type: string;
          payload: unknown;
        };
        if (
          message.type === "room.snapshot" ||
          message.type === "host.changed"
        ) {
          const next = message.payload as RoomSnapshot;
          setSnapshot(next);
          if (clockOffsetMsRef.current === null)
            clockOffsetMsRef.current = next.serverNowMs - Date.now();
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
            setClockRttMs(Math.round(stable.roundTripMs));
          }
        }
        if (message.type === "room.command.rejected")
          setError("操作未生效，状态已刷新");
      });
    };

    connect();
    const calibrationTimer = window.setInterval(() => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) scheduleClockBurst(socket, 3);
    }, 30_000);
    const recalibrate = () => {
      if (document.visibilityState === "hidden") return;
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) scheduleClockBurst(socket);
    };
    document.addEventListener("visibilitychange", recalibrate);
    addEventListener("online", recalibrate);
    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      window.clearInterval(calibrationTimer);
      clockBurstTimersRef.current.forEach(window.clearTimeout);
      clockBurstTimersRef.current = [];
      document.removeEventListener("visibilitychange", recalibrate);
      removeEventListener("online", recalibrate);
      socketRef.current?.close(1000, "page leave");
      socketRef.current = null;
    };
  }, [joined, navigate, roomId]);

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
    if (snapshot?.mode !== "vod") return;
    const timer = window.setInterval(() => reconcileVod("periodic"), 500);
    return () => window.clearInterval(timer);
  }, [durationSec, snapshot?.media?.id, snapshot?.mode]);

  useEffect(() => {
    if (snapshot?.mode !== "live" || isHost || liveProgramState !== "playing")
      return;
    const update = () => void collectLiveStats();
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [isHost, liveProgramState, snapshot?.mode]);

  useEffect(() => {
    if (snapshot?.mode !== "live" || isHost) {
      closeLiveProgram();
      return;
    }
    if (!programEnabled || liveStatus.data?.state !== "online") {
      if (liveStatus.data?.state === "offline") closeLiveProgram();
      return;
    }
    if (!liveReaderRef.current) void enableLiveProgram();
  }, [
    isHost,
    liveRetry,
    liveStatus.data?.state,
    programEnabled,
    snapshot?.mode,
  ]);

  useEffect(
    () => () => {
      voiceRoomRef.current?.disconnect();
      voiceRoomRef.current = null;
      closeLiveProgram();
    },
    [],
  );

  function command(commandPayload: Record<string, unknown>) {
    if (!snapshot || socketRef.current?.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(
      JSON.stringify(
        envelope(roomId, "room.command", {
          commandId: uuidv7(),
          expectedRevision: snapshot.revision,
          effectiveAtServerMs: Date.now() + 750,
          command: commandPayload,
        }),
      ),
    );
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
      currentSnapshot.mode !== "vod" ||
      video.readyState === HTMLMediaElement.HAVE_NOTHING
    )
      return;

    const serverNowMs = Date.now() + (clockOffsetMsRef.current ?? 0);
    const elapsedMs = Math.max(0, serverNowMs - transport.anchoredAtServerMs);
    const desired =
      transport.positionSec +
      (transport.state === "playing" ? (elapsedMs / 1000) * transport.rate : 0);
    const maximum =
      durationSec ||
      (Number.isFinite(video.duration) ? video.duration : desired);
    const boundedDesired = clamp(desired, 0, maximum || desired);
    const driftSeconds = boundedDesired - video.currentTime;
    setSyncDeltaMs(Math.round(driftSeconds * 1000));

    if (transport.state === "paused") {
      video.pause();
      video.playbackRate = transport.rate;
      if (Math.abs(driftSeconds) > 0.05) seekVideo(video, boundedDesired);
      excessiveDriftSinceRef.current = null;
      setSyncFailed(false);
      setPlayheadSec(boundedDesired);
      writeProgramDiagnostics(video, event);
      return;
    }

    const correction = decideDriftCorrection(driftSeconds, transport.rate);
    if (correction.kind === "seek") seekVideo(video, boundedDesired);
    video.playbackRate = correction.playbackRate;
    if (programEnabledRef.current) void video.play().catch(() => undefined);
    else video.pause();

    if (Math.abs(driftSeconds) > 1) {
      excessiveDriftSinceRef.current ??= Date.now();
      if (Date.now() - excessiveDriftSinceRef.current >= 5_000)
        setSyncFailed(true);
    } else {
      excessiveDriftSinceRef.current = null;
      setSyncFailed(false);
    }
    setPlayheadSec(video.currentTime);
    writeProgramDiagnostics(video, event);
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
      voiceRoomRef.current?.disconnect();
      voiceRoomRef.current = null;
      setVoiceState("error");
      setError(
        voiceError instanceof Error ? voiceError.message : "语音连接失败",
      );
    }
  }

  async function enableLiveProgram() {
    if (!roomCsrf || liveReaderRef.current || isHost) return;
    const generation = ++liveReaderGenerationRef.current;
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
              if (liveTracksRef.current.get(kind)?.id === track.id)
                liveTracksRef.current.delete(kind);
            },
            { once: true },
          );
          video.srcObject = stream;
          video.volume = preferences.programVolume / 100;
          writeProgramDiagnostics(video, "live-track-added");
          if (
            stream.getAudioTracks().length !== 1 ||
            stream.getVideoTracks().length !== 1
          )
            return;
          void video
            .play()
            .then(() => setLiveProgramState("playing"))
            .catch(() => {
              setLiveProgramState("error");
              setError("浏览器阻止了节目声音，请再次点击“启用节目声音”");
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
      if (generation === liveReaderGenerationRef.current)
        scheduleLiveRetry(
          readerError instanceof Error
            ? `直播连接失败，正在重试：${readerError.message}`
            : "直播连接失败，正在重试",
        );
    }
  }

  function scheduleLiveRetry(message: string) {
    closeLiveProgram();
    setLiveProgramState("error");
    setError(message);
    liveRetryTimerRef.current = replaceRetryTimer(
      liveRetryTimerRef.current,
      window.clearTimeout,
      window.setTimeout,
      () => setLiveRetry((value) => value + 1),
      2000,
    );
  }

  function closeLiveProgram() {
    liveReaderGenerationRef.current += 1;
    window.clearTimeout(liveRetryTimerRef.current);
    liveRetryTimerRef.current = 0;
    liveReaderRef.current?.close();
    liveReaderRef.current = null;
    liveStreamRef.current?.getTracks().forEach((track) => track.stop());
    liveStreamRef.current = null;
    liveTracksRef.current.clear();
    previousLiveStatsRef.current = null;
    setLiveStats(null);
    if (videoRef.current?.srcObject) videoRef.current.srcObject = null;
    setLiveProgramState("idle");
  }

  async function collectLiveStats() {
    const peer = liveReaderRef.current?.getPeerConnection();
    if (!peer) return;
    const report = await peer.getStats();
    let video: InboundVideoStats | null = null;
    let candidatePair: CandidatePairStats | null = null;
    let protocol = "unknown";
    report.forEach((entry) => {
      if (
        entry.type === "inbound-rtp" &&
        entry.kind === "video" &&
        !entry.isRemote
      )
        video = entry as InboundVideoStats;
      if (entry.type === "transport" && entry.selectedCandidatePairId) {
        const selected = report.get(entry.selectedCandidatePairId);
        if (selected?.type === "candidate-pair")
          candidatePair = selected as CandidatePairStats;
      }
    });
    const videoStats = video as InboundVideoStats | null;
    const selectedPair = candidatePair as CandidatePairStats | null;
    if (!videoStats) return;
    if (selectedPair) {
      const local = report.get(selectedPair.localCandidateId);
      protocol =
        local?.type === "local-candidate" && typeof local.protocol === "string"
          ? local.protocol.toUpperCase()
          : "unknown";
    }
    const now = performance.now();
    const bytes = videoStats.bytesReceived ?? 0;
    const packets = videoStats.packetsReceived ?? 0;
    const lost = videoStats.packetsLost ?? 0;
    const previous = previousLiveStatsRef.current;
    const elapsedSeconds = previous ? (now - previous.atMs) / 1000 : 0;
    const bitrateMbps =
      previous && elapsedSeconds > 0
        ? ((bytes - previous.bytes) * 8) / elapsedSeconds / 1_000_000
        : 0;
    const receivedDelta = previous
      ? Math.max(0, packets - previous.packets)
      : 0;
    const lostDelta = previous ? Math.max(0, lost - previous.lost) : 0;
    const packetLossPercent =
      receivedDelta + lostDelta > 0
        ? (lostDelta / (receivedDelta + lostDelta)) * 100
        : 0;
    previousLiveStatsRef.current = { atMs: now, bytes, packets, lost };
    const rttMs = selectedPair?.currentRoundTripTime
      ? selectedPair.currentRoundTripTime * 1000
      : null;
    const jitterMs = (videoStats.jitter ?? 0) * 1000;
    const jitterBufferMs =
      videoStats.jitterBufferEmittedCount && videoStats.jitterBufferDelay
        ? (videoStats.jitterBufferDelay / videoStats.jitterBufferEmittedCount) *
          1000
        : null;
    const framesPerSecond = videoStats.framesPerSecond ?? 0;
    setLiveStats({
      bitrateMbps,
      packetLossPercent,
      rttMs,
      jitterMs,
      jitterBufferMs,
      framesPerSecond,
      protocol,
      health: classifyViewerHealth(packetLossPercent, rttMs, framesPerSecond),
    });
    sessionStorage.setItem(
      "simplewatch.live-diagnostics",
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        bitrateMbps: round(bitrateMbps, 2),
        packetLossPercent: round(packetLossPercent, 2),
        rttMs: rttMs === null ? null : round(rttMs, 0),
        jitterMs: round(jitterMs, 1),
        jitterBufferMs:
          jitterBufferMs === null ? null : round(jitterBufferMs, 1),
        framesPerSecond: round(framesPerSecond, 1),
        protocol,
      }),
    );
  }

  async function enableProgramSound() {
    setProgramEnabled(true);
    setError("");
    const video = videoRef.current;
    if (video) {
      video.muted = false;
      video.volume = preferences.programVolume / 100;
      if (snapshot?.mode === "vod" && snapshot.transport?.state === "playing") {
        await video
          .play()
          .catch(() => setError("无法启用节目声音，请检查浏览器媒体权限"));
      } else if (snapshot?.mode === "vod") {
        // A short play/pause in the direct click gesture unlocks later
        // synchronized playback without starting the room early.
        await video
          .play()
          .then(() => video.pause())
          .catch(() => setError("无法启用节目声音，请检查浏览器媒体权限"));
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
    if (!isHost || !snapshot?.transport) return;
    if (!programEnabled) await enableProgramSound();
    command({
      kind: snapshot.transport.state === "playing" ? "pause" : "play",
    });
  }

  function commitSeek(positionSec: number) {
    if (!isHost || !durationSec) return;
    const next = clamp(positionSec, 0, durationSec);
    setSeekDraftSec(null);
    command({ kind: "seek", positionSec: next });
  }

  function reloadVodProgram() {
    const video = videoRef.current;
    if (!video) return;
    setSyncFailed(false);
    excessiveDriftSinceRef.current = null;
    video.load();
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
    setSnapshot(result);
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
    voiceRoomRef.current?.disconnect();
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
      voiceRoomRef.current?.disconnect();
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
            请重新打开好友发送的固定入场链接，只需输入昵称即可回来。
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
              <span>播放器将继续自动纠偏；若仍从头播放，请重新加载节目。</span>
              <button type="button" onClick={() => reloadVodProgram()}>
                重新加载节目
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
            <video ref={videoRef} controls={false} playsInline />
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
              <button onClick={() => command({ kind: "restore-vod" })}>
                返回服务器影片
              </button>
            </div>
          ) : snapshot?.media ? (
            <video
              ref={videoRef}
              src={`/api/v1/media/${snapshot.media.id}/content`}
              controls={false}
              playsInline
              preload="auto"
              onLoadedMetadata={(event) => {
                updateProgramMetrics(event.currentTarget, "loaded-metadata");
                reconcileVod("loaded-metadata");
              }}
              onCanPlay={() => reconcileVod("can-play")}
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
              onWaiting={(event) => {
                stallCountRef.current += 1;
                updateProgramMetrics(event.currentTarget, "waiting");
              }}
              onError={(event) => {
                updateProgramMetrics(event.currentTarget, "error");
                setError(
                  media.data?.video.codec === "hevc"
                    ? "当前终端无法解码这条 H.265 影片，服务器不会转码"
                    : "影片加载失败，请检查网络或文件状态",
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
              <span>
                接收 {liveStats ? liveStats.bitrateMbps.toFixed(2) : "—"} Mbps
              </span>
              <span>
                {liveStats ? liveStats.framesPerSecond.toFixed(0) : "—"} fps
              </span>
              <span>
                丢包 {liveStats ? liveStats.packetLossPercent.toFixed(2) : "—"}%
              </span>
              <span>
                RTT {liveStats?.rttMs ? liveStats.rttMs.toFixed(0) : "—"} ms
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
                disabled={!isHost}
                onClick={() => void toggleVodPlayback()}
              >
                {snapshot?.transport?.state === "playing" ? "Ⅱ 暂停" : "▶ 播放"}
              </button>
              <button
                disabled={!isHost}
                onClick={() => commitSeek(displayedPositionSec - 10)}
              >
                −10s
              </button>
              <button
                disabled={!isHost}
                onClick={() => commitSeek(displayedPositionSec + 10)}
              >
                +10s
              </button>
              <div className="playback-scrubber">
                <input
                  aria-label="播放进度"
                  type="range"
                  min="0"
                  max={Math.max(durationSec, 0.1)}
                  step="0.1"
                  disabled={!isHost || durationSec <= 0}
                  value={displayedPositionSec}
                  style={
                    {
                      "--playhead-percent": `${durationSec ? (displayedPositionSec / durationSec) * 100 : 0}%`,
                      "--buffered-percent": `${durationSec ? (Math.min(durationSec, playheadSec + bufferedAheadSec) / durationSec) * 100 : 0}%`,
                    } as CSSProperties
                  }
                  onPointerDown={() => {
                    seekingRef.current = true;
                  }}
                  onChange={(event) =>
                    setSeekDraftSec(Number(event.currentTarget.value))
                  }
                  onPointerUp={(event) => {
                    seekingRef.current = false;
                    commitSeek(Number(event.currentTarget.value));
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
                      ].includes(event.key)
                    )
                      commitSeek(Number(event.currentTarget.value));
                  }}
                  onBlur={(event) => {
                    if (!seekingRef.current) return;
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
                disabled={!isHost}
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
                  ? snapshot?.mode === "live" &&
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
            <section className="host-controls">
              <strong>主持控制</strong>
              <select
                aria-label="选择点播影片"
                defaultValue=""
                onChange={(event) =>
                  event.target.value &&
                  command({ kind: "select-vod", mediaId: event.target.value })
                }
              >
                <option value="">选择片库影片</option>
                {library.data
                  ?.filter((item) => item.state === "published")
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.displayName}
                    </option>
                  ))}
              </select>
              {snapshot?.mode === "live" ? (
                <button onClick={() => command({ kind: "restore-vod" })}>
                  返回服务器影片
                </button>
              ) : (
                <button onClick={() => command({ kind: "select-live" })}>
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

function seekVideo(video: HTMLVideoElement, positionSec: number): void {
  try {
    video.currentTime = positionSec;
  } catch {
    // Some engines reject seeks until metadata is ready. loadedmetadata and
    // canplay both invoke reconciliation again, so this target is not lost.
  }
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

interface LiveStatsSample {
  readonly atMs: number;
  readonly bytes: number;
  readonly packets: number;
  readonly lost: number;
}

interface InboundVideoStats extends RTCStats {
  readonly bytesReceived?: number;
  readonly packetsReceived?: number;
  readonly packetsLost?: number;
  readonly jitter?: number;
  readonly jitterBufferDelay?: number;
  readonly jitterBufferEmittedCount?: number;
  readonly framesPerSecond?: number;
}

interface CandidatePairStats extends RTCStats {
  readonly localCandidateId: string;
  readonly currentRoundTripTime?: number;
}

export interface LiveViewerStats {
  readonly bitrateMbps: number;
  readonly packetLossPercent: number;
  readonly rttMs: number | null;
  readonly jitterMs: number;
  readonly jitterBufferMs: number | null;
  readonly framesPerSecond: number;
  readonly protocol: string;
  readonly health: "good" | "degraded" | "poor";
}

export function classifyViewerHealth(
  packetLossPercent: number,
  rttMs: number | null,
  framesPerSecond: number,
): LiveViewerStats["health"] {
  if (
    packetLossPercent > 3 ||
    (rttMs ?? 0) > 400 ||
    (framesPerSecond > 0 && framesPerSecond < 20)
  )
    return "poor";
  if (
    packetLossPercent > 1 ||
    (rttMs ?? 0) > 250 ||
    (framesPerSecond > 0 && framesPerSecond < 27)
  )
    return "degraded";
  return "good";
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
    return "OBS 到服务器的上行正在丢包，请降低 OBS 码率或更换发起端网络。";
  if (viewer && viewer.packetLossPercent > 1)
    return "OBS 上行正常，当前观看端下行丢包较高。";
  if (viewer && viewer.framesPerSecond > 0 && viewer.framesPerSecond < 27)
    return "网络未见明显丢包，但当前终端解码或渲染帧率不足。";
  return "";
}
