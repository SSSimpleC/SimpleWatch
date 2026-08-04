import { useEffect, useState } from "react";
import { Link } from "react-router";

import { loadPreferences, savePreferences } from "../preferences.js";

export function SettingsPage() {
  const [preferences, setPreferences] = useState(loadPreferences);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((items) =>
        setDevices(items.filter((item) => item.kind === "audioinput")),
      )
      .catch(() => setDevices([]));
  }, []);
  useEffect(() => savePreferences(preferences), [preferences]);

  return (
    <main className="console-shell settings-shell">
      <Link to="/" className="brand-mark">
        SW / 门厅
      </Link>
      <section className="panel settings-panel">
        <p className="eyebrow">LOCAL PLAYBACK</p>
        <h1>声音与设备</h1>
        <Volume
          label="节目音量"
          value={preferences.programVolume}
          onChange={(programVolume) =>
            setPreferences({ ...preferences, programVolume })
          }
        />
        <Volume
          label="通话音量"
          value={preferences.callVolume}
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
            {devices.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label || `麦克风 ${device.deviceId.slice(0, 6)}`}
              </option>
            ))}
          </select>
        </label>
        <label className="check-row">
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
        <label className="check-row">
          <input
            type="checkbox"
            checked={preferences.autoDuck}
            onChange={(event) =>
              setPreferences({ ...preferences, autoDuck: event.target.checked })
            }
          />
          有人发言时自动压低节目
        </label>
        <p className="muted-copy">设置仅保存在本机，不会改变其他观众的声音。</p>
      </section>
    </main>
  );
}

function Volume({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange(value: number): void;
}) {
  return (
    <label>
      {label} <output aria-hidden="true">{value}%</output>
      <input
        aria-label={label}
        type="range"
        min="0"
        max="100"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}
