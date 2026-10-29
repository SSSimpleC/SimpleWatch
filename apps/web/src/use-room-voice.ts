import { useEffect, useRef, useState } from "react";

import type { AudioPreferences } from "./preferences.js";
import {
  getMicrophoneGain,
  subscribeAudioPreferenceResets,
} from "./preferences.js";
import { SESSION_RELEASE_EVENT } from "./session-lifecycle.js";
import { useSession } from "./store.js";
import {
  requestVoiceCredentials,
  type VoiceBootstrap,
} from "./voice-credentials.js";
import type { VoiceSession } from "./voice/session.js";
import {
  trackVoiceOwnerRelease,
  waitForVoiceOwnerRelease,
} from "./voice-owner-lifecycle.js";
import {
  initialVoiceState,
  type VoiceDiagnostics,
  type VoiceMember,
  type VoiceSettings,
} from "./voice/types.js";

interface RoomVoiceOptions {
  accountId: string | null;
  roomId: string;
  memberId: string | null;
  enabled: boolean;
  members: readonly VoiceMember[];
  preferences: AudioPreferences;
  transientVolumes: Readonly<Record<string, number>>;
  onBootstrap(value: VoiceBootstrap): void;
}

export function useRoomVoice(options: RoomVoiceOptions) {
  const latest = useRef(options);
  latest.current = options;
  const session = useRef<VoiceSession | null>(null);
  const teardown = useRef<Promise<void>>(Promise.resolve());
  const [state, setState] = useState(initialVoiceState);
  const [diagnostics, setDiagnostics] = useState<VoiceDiagnostics | null>(null);
  const [retry, setRetry] = useState(0);
  const [released, setReleased] = useState(false);
  const [anyoneSpeaking, setAnyoneSpeaking] = useState(false);

  const settings = (): VoiceSettings => {
    const value = latest.current;
    return {
      masterVolume: value.preferences.callVolume,
      participantVolumes: {
        ...value.preferences.participantVolumes,
        ...value.transientVolumes,
      },
      microphoneGain: getMicrophoneGain(
        value.preferences,
        state.activeInputDeviceId,
      ),
      inputDeviceId: value.preferences.inputDeviceId,
      mode: value.preferences.mode,
    };
  };

  useEffect(() => {
    setReleased(false);
  }, [options.accountId, options.roomId]);

  useEffect(() => {
    const release = () => {
      setReleased(true);
      void session.current?.disconnect();
    };
    window.addEventListener(SESSION_RELEASE_EVENT, release);
    return () => window.removeEventListener(SESSION_RELEASE_EVENT, release);
  }, []);

  useEffect(() => {
    const { accountId, roomId, memberId, enabled } = latest.current;
    if (!enabled || !accountId || !memberId || released) return;
    let active = true;
    let owner: VoiceSession | null = null;
    setState(initialVoiceState);
    setDiagnostics(null);
    setAnyoneSpeaking(false);
    // A previous owner may still be releasing its Web Lock. Never race ourselves.
    void Promise.all([teardown.current, waitForVoiceOwnerRelease(accountId)])
      .then(() => import("./voice/session.js"))
      .then(({ VoiceSession: Session }) => {
        if (!active) return;
        owner = new Session({
          accountId,
          roomId,
          members: [...latest.current.members],
          settings: settings(),
          resolveMicrophoneGain: (deviceId) =>
            getMicrophoneGain(latest.current.preferences, deviceId),
          getCredentials: (signal) =>
            requestVoiceCredentials(
              { accountId, roomId, memberId },
              signal,
              () => {
                const value = latest.current;
                const auth = useSession.getState();
                return active &&
                  value.enabled &&
                  value.accountId &&
                  value.memberId &&
                  auth.account?.id === accountId
                  ? {
                      accountId: value.accountId,
                      roomId: value.roomId,
                      memberId: value.memberId,
                      csrf: auth.roomCsrf,
                    }
                  : null;
              },
              (bootstrap) => latest.current.onBootstrap(bootstrap),
            ),
          onState: (next) => {
            if (active) setState(next);
          },
          onSpeakers: (members) => {
            if (active) setAnyoneSpeaking(members.length > 0);
          },
        });
        session.current = owner;
        return owner.connect();
      })
      .catch((error: unknown) => {
        if (active)
          setState({
            ...initialVoiceState,
            connection: "error",
            error: error instanceof Error ? error.message : "语音模块加载失败",
          });
      });
    return () => {
      active = false;
      if (session.current === owner) session.current = null;
      if (owner)
        teardown.current = trackVoiceOwnerRelease(
          accountId,
          owner.disconnect(),
        );
    };
  }, [
    options.accountId,
    options.roomId,
    options.memberId,
    options.enabled,
    released,
    retry,
  ]);

  useEffect(() => {
    session.current?.updateSettings(settings());
  }, [
    options.preferences,
    options.transientVolumes,
    state.activeInputDeviceId,
  ]);
  useEffect(() => {
    session.current?.updateMembers([...options.members]);
  }, [options.members]);
  useEffect(() => {
    // Changing PTT configuration never implicitly arms or opens the microphone.
    void session.current?.closeMicrophone();
  }, [options.preferences.pushToTalk]);
  useEffect(
    () =>
      subscribeAudioPreferenceResets(() => {
        void session.current?.closeMicrophone();
      }),
    [],
  );
  useEffect(() => {
    if (!options.preferences.pushToTalk) return;
    const keyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      if (
        event.target instanceof Element &&
        event.target.closest(
          "input, textarea, select, button, [contenteditable], [role=slider]",
        )
      )
        return;
      const microphone = session.current?.getState().microphone;
      if (microphone !== "armed" && microphone !== "transmitting") return;
      event.preventDefault();
      session.current?.setPushToTalkPressed(true);
    };
    window.addEventListener("keydown", keyDown);
    return () => window.removeEventListener("keydown", keyDown);
  }, [options.preferences.pushToTalk]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible")
        setDiagnostics(session.current?.getDiagnostics() ?? null);
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  return {
    state,
    diagnostics,
    anyoneSpeaking,
    enableAudio: () => {
      void session.current?.enableAudio();
    },
    toggleMicrophone: () => {
      if (state.microphone === "off" || state.microphone === "error") {
        void session.current?.enableAudio();
        void session.current?.openMicrophone(
          latest.current.preferences.pushToTalk,
        );
      } else void session.current?.closeMicrophone();
    },
    pressToTalk: (pressed: boolean) => {
      void session.current?.setPushToTalkPressed(pressed);
    },
    retry: () => {
      setReleased(false);
      setRetry((value) => value + 1);
    },
    takeOverTab: () => {
      void session.current?.takeOverTab();
    },
    disconnect: async () => {
      setReleased(true);
      await session.current?.disconnect();
    },
  };
}
