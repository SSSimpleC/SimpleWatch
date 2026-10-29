import { useEffect, useState } from "react";
import { Link } from "react-router";

import { api, type AccountSession } from "../api.js";
import {
  AudioLevelControl,
  SystemAudioHelp,
} from "../components/VoicePanel.js";
import {
  getMicrophoneGain,
  isRememberableMicrophoneDevice,
  withMicrophoneGain,
} from "../preferences.js";
import { currentSessionGeneration } from "../session-generation.js";
import { useSession } from "../store.js";
import { useAudioPreferences } from "../use-audio-preferences.js";

export function SettingsPage() {
  const { account, setAccount, setAdminCsrf } = useSession();
  const { preferences, setPreferences, clearAudioPreferences } =
    useAudioPreferences(account?.id);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [checking, setChecking] = useState(!account);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (account) {
      setChecking(false);
      return;
    }
    let active = true;
    const generation = currentSessionGeneration();
    void api<AccountSession>("/api/v1/auth/session")
      .then((session) => {
        if (!active || generation !== currentSessionGeneration()) return;
        setAccount(session.account);
        setAdminCsrf(session.csrfToken);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, [account, setAccount, setAdminCsrf]);

  useEffect(() => {
    if (!account || !navigator.mediaDevices) return;
    let active = true;
    const refreshDevices = () => {
      void navigator.mediaDevices
        .enumerateDevices()
        .then((items) => {
          if (active)
            setDevices(items.filter((item) => item.kind === "audioinput"));
        })
        .catch(() => {
          if (active) setDevices([]);
        });
    };
    refreshDevices();
    navigator.mediaDevices.addEventListener("devicechange", refreshDevices);
    return () => {
      active = false;
      navigator.mediaDevices.removeEventListener(
        "devicechange",
        refreshDevices,
      );
    };
  }, [account]);

  function resetPreferences() {
    if (
      !window.confirm(
        "清除这个浏览器中所有账户保存的声音设置？不会删除账户或影片。",
      )
    )
      return;
    clearAudioPreferences();
    setNotice("本机声音设置已清除。语音总音量恢复为 50%，麦克风不会自动开启。");
  }

  if (!account)
    return (
      <main className="console-shell settings-shell">
        <Link to="/" className="brand-mark">
          SW / 门厅
        </Link>
        <section className="panel settings-panel">
          <p className="eyebrow">LOCAL SOUND</p>
          <h1>声音与设备</h1>
          <p role="status">
            {checking
              ? "正在核验登录状态…"
              : "请先登录，再读取本账户的声音设置。"}
          </p>
          {!checking && (
            <Link to="/" className="text-link">
              返回门厅登录
            </Link>
          )}
        </section>
      </main>
    );

  return (
    <main className="console-shell settings-shell">
      <Link to="/" className="brand-mark">
        SW / 门厅
      </Link>
      <section className="panel settings-panel voice-settings">
        <p className="eyebrow">LOCAL PLAYBACK</p>
        <h1>声音与设备</h1>
        <p className="voice-panel__hint">
          {account.username} ·
          仅当前浏览器。正常登出后保留音量，重新入房仍关闭麦克风。
        </p>
        <AudioLevelControl
          id="settings-program-volume"
          label="节目音量"
          value={preferences.programVolume}
          maximum={100}
          onChange={(programVolume) =>
            setPreferences({ ...preferences, programVolume })
          }
        />
        <AudioLevelControl
          id="settings-call-volume"
          label="语音总音量"
          value={preferences.callVolume}
          maximum={100}
          onChange={(callVolume) =>
            setPreferences({ ...preferences, callVolume })
          }
        />
        <label>
          输入设备
          <select
            value={preferences.inputDeviceId}
            onChange={(event) =>
              setPreferences({
                ...preferences,
                inputDeviceId: event.target.value,
              })
            }
          >
            <option value="">系统默认麦克风</option>
            {preferences.inputDeviceId &&
              !devices.some(
                (device) => device.deviceId === preferences.inputDeviceId,
              ) && (
                <option value={preferences.inputDeviceId}>
                  之前的麦克风（当前不可用）
                </option>
              )}
            {devices
              .filter((device) =>
                isRememberableMicrophoneDevice(device.deviceId),
              )
              .map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `麦克风 ${index + 1}`}
                </option>
              ))}
          </select>
        </label>
        <p className="voice-panel__hint">
          这里只选择设备，不申请麦克风权限。新设备从 100%
          开始；系统默认设备需在房间首次开麦后确认，才可调节发送增益。未授权时设备名称可能不可见。
        </p>
        <AudioLevelControl
          id="settings-microphone-gain"
          label="麦克风发送增益"
          value={getMicrophoneGain(preferences)}
          maximum={200}
          disabled={!isRememberableMicrophoneDevice(preferences.inputDeviceId)}
          onChange={(gain) =>
            setPreferences(withMicrophoneGain(preferences, gain))
          }
        />
        <p className="voice-panel__hint">
          发送增益为应用内数字放大，不改变系统硬件音量。0%
          不是关闭采集；开关麦克风请在房间内操作。
        </p>
        <label>
          麦克风处理模式
          <select
            value={preferences.mode}
            onChange={(event) =>
              setPreferences({
                ...preferences,
                mode:
                  event.target.value === "original" ? "original" : "dialogue",
              })
            }
          >
            <option value="dialogue">对话优先（回声消除、降噪）</option>
            <option value="original">原声（建议佩戴耳机）</option>
          </select>
        </label>
        <p className="voice-panel__hint">
          两种模式的 Opus 编码目标均为 96
          kbps。支持时保留实际双声道，否则回退单声道；原声模式仍保留软峰值保护。
        </p>
        <label className="voice-panel__check">
          <input
            type="checkbox"
            checked={preferences.pushToTalk}
            onChange={(event) =>
              setPreferences({
                ...preferences,
                pushToTalk: event.target.checked,
              })
            }
          />
          按键说话
        </label>
        <label className="voice-panel__check">
          <input
            type="checkbox"
            checked={preferences.autoDuck}
            onChange={(event) =>
              setPreferences({ ...preferences, autoDuck: event.target.checked })
            }
          />
          有人发言时自动压低节目
        </label>
        <p className="voice-panel__hint">
          按键说话需每次主动启用。待命时麦克风仍在使用；失焦或进入后台将关闭采集。
        </p>
        <SystemAudioHelp />
        <p className="voice-panel__hint">
          每位成员的 0–500%
          收听音量在房间的“同场声音”中调整，按成员身份跨房间记忆。
        </p>
        <button
          type="button"
          className="voice-settings__reset"
          onClick={resetPreferences}
        >
          清除本机声音设置
        </button>
        {notice && (
          <p className="voice-panel__hint" role="status">
            {notice}
          </p>
        )}
      </section>
    </main>
  );
}
