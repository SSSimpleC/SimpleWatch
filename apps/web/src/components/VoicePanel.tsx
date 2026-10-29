import { useEffect, useId, useRef, useState, type CSSProperties } from "react";

import {
  getMicrophoneGain,
  isRememberableMicrophoneDevice,
  withMicrophoneGain,
  type AudioPreferences,
} from "../preferences.js";
import "./voice-panel.css";

export interface VoicePanelParticipant {
  id: string;
  accountId: string | null;
  nickname: string;
  volume: number;
  connected: boolean;
  speaking: boolean;
  muted: boolean;
  level?: number;
}

export interface VoicePanelProps {
  preferences: AudioPreferences;
  onPreferencesChange(next: AudioPreferences): void;
  selfName: string;
  participants: readonly VoicePanelParticipant[];
  connection:
    | "idle"
    | "connecting"
    | "connected"
    | "reconnecting"
    | "error"
    | "other-tab"
    | "unsupported";
  output: "awaiting-gesture" | "running" | "interrupted" | "failed";
  microphone: "off" | "requesting" | "armed" | "transmitting" | "error";
  inputDevices: readonly { deviceId: string; label: string }[];
  effectiveInputDeviceId?: string;
  microphoneLevel?: number;
  microphoneOverloaded?: boolean;
  outputOverloaded?: boolean;
  channels?: 1 | 2 | null;
  error?: string | null;
  microphoneError?: string | null;
  diagnostics?: readonly { label: string; value: string }[];
  onEnableAudio(): void;
  onToggleMicrophone(): void;
  onRetry(): void;
  onTakeover?(): void;
  onPushToTalk(pressed: boolean): void;
  onParticipantVolumeChange(memberId: string, volume: number): void;
}

const connectionText: Record<VoicePanelProps["connection"], string> = {
  idle: "等待加入语音",
  connecting: "正在连接语音",
  connected: "已加入语音频道",
  reconnecting: "语音正在重连",
  error: "语音连接待重试",
  "other-tab": "语音由另一标签页使用",
  unsupported: "此浏览器暂不支持增强语音",
};

const microphoneText: Record<VoicePanelProps["microphone"], string> = {
  off: "麦克风关闭 · 未采集",
  requesting: "等待麦克风授权",
  armed: "按键待命 · 麦克风仍在使用",
  transmitting: "麦克风开启 · 正在发送",
  error: "麦克风暂不可用 · 仍可收听",
};

export function VoicePanel(props: VoicePanelProps) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const drawer = useRef<HTMLDialogElement>(null);
  const lastVolumes = useRef(new Map<string, number>());
  const lastMasterVolume = useRef(50);
  const { preferences, microphone, connection } = props;
  const capturing = microphone === "armed" || microphone === "transmitting";
  const microphoneDisabled =
    connection !== "connected" || microphone === "requesting";
  const gainDeviceId =
    props.effectiveInputDeviceId ?? preferences.inputDeviceId;
  const gainDeviceKnown = isRememberableMicrophoneDevice(gainDeviceId);
  const microphoneAction = capturing
    ? "关闭麦克风"
    : preferences.pushToTalk
      ? "启用按键说话"
      : "打开麦克风";

  useEffect(() => {
    if (preferences.callVolume > 0)
      lastMasterVolume.current = preferences.callVolume;
    for (const participant of props.participants) {
      if (participant.volume > 0)
        lastVolumes.current.set(participant.id, participant.volume);
    }
    const currentIds = new Set(
      props.participants.map((participant) => participant.id),
    );
    for (const memberId of lastVolumes.current.keys()) {
      if (!currentIds.has(memberId)) lastVolumes.current.delete(memberId);
    }
  }, [preferences.callVolume, props.participants]);

  useEffect(() => {
    const element = drawer.current;
    if (!element) return;
    if (expanded && !element.open) element.showModal();
    else if (!expanded && element.open) element.close();
  }, [expanded]);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 761px)");
    const closeOnDesktop = () => {
      if (desktop.matches) setExpanded(false);
    };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);

  function toggleParticipant(participant: VoicePanelParticipant) {
    const previous = participant.accountId
      ? preferences.participantPreviousVolumes[participant.accountId]
      : undefined;
    const restore = previous ?? lastVolumes.current.get(participant.id) ?? 100;
    props.onParticipantVolumeChange(
      participant.id,
      participant.volume > 0 ? 0 : restore > 0 ? restore : 100,
    );
  }

  function mixer(location: string) {
    return (
      <div className="voice-panel__body">
        <header className="voice-panel__header">
          <div>
            <span className="eyebrow">VOICE / MIXER</span>
            <h2 id={`${id}-${location}-title`}>同场声音</h2>
          </div>
          <span className="voice-panel__quality">Opus · 96 kbps 目标</span>
        </header>
        <div className="voice-panel__connection" role="status">
          <i data-connected={connection === "connected"} aria-hidden="true" />
          <span>{connectionText[connection]}</span>
        </div>
        <div className="voice-panel__microphone-quick">
          <p className="voice-panel__mic-state" role="status">
            {microphoneText[microphone]}
          </p>
          <button
            type="button"
            className="voice-panel__mic-switch"
            disabled={microphoneDisabled}
            aria-pressed={capturing}
            onClick={props.onToggleMicrophone}
          >
            {microphoneAction}
          </button>
        </div>
        {props.error && (
          <p className="voice-panel__error" role="alert">
            {props.error}
          </p>
        )}
        {connection === "other-tab" && props.onTakeover && (
          <button type="button" onClick={props.onTakeover}>
            在此标签页使用语音
          </button>
        )}
        {(connection === "error" || connection === "idle") && (
          <button type="button" onClick={props.onRetry}>
            重新连接语音
          </button>
        )}
        {props.output !== "running" && connection === "connected" && (
          <div className="voice-panel__unlock">
            <p>
              {props.output === "awaiting-gesture"
                ? "已在频道中，点按后才能播放语音。"
                : "声音输出已中断，点按尝试恢复。"}
            </p>
            <button type="button" onClick={props.onEnableAudio}>
              {props.output === "awaiting-gesture"
                ? "启用语音声音"
                : "恢复语音声音"}
            </button>
          </div>
        )}
        <section className="voice-panel__master" aria-label="语音总音量">
          <AudioLevelControl
            id={`${id}-${location}-master`}
            label="语音总音量"
            value={preferences.callVolume}
            maximum={100}
            onChange={(callVolume) =>
              props.onPreferencesChange({ ...preferences, callVolume })
            }
          />
          <button
            type="button"
            className="voice-panel__quiet-button"
            onClick={() =>
              props.onPreferencesChange({
                ...preferences,
                callVolume:
                  preferences.callVolume > 0 ? 0 : lastMasterVolume.current,
              })
            }
          >
            {preferences.callVolume === 0 ? "恢复语音总音量" : "静音所有语音"}
          </button>
          <p className="voice-panel__hint">
            只影响语音，不改变影片声音。首次为 50%，之后记忆。
          </p>
          {props.outputOverloaded && (
            <p className="voice-panel__warning" role="status">
              混音声音过强，建议降低总音量或个别成员音量。软峰值保护不能恢复已失真的声音。
            </p>
          )}
        </section>
        <section
          className="voice-panel__channel voice-panel__self"
          aria-label="自己的麦克风"
        >
          <header className="voice-panel__channel-heading">
            <div>
              <span className="voice-panel__channel-tag">我的发送</span>
              <h3>{props.selfName}</h3>
            </div>
            <span className="voice-panel__channel-badge">自己</span>
          </header>
          {props.microphoneError && (
            <p className="voice-panel__error" role="alert">
              {props.microphoneError}；收听与影片播放不受影响。
            </p>
          )}
          {preferences.pushToTalk && capturing && (
            <button
              type="button"
              className="voice-panel__ptt"
              aria-pressed={microphone === "transmitting"}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                props.onPushToTalk(true);
              }}
              onPointerUp={() => props.onPushToTalk(false)}
              onPointerCancel={() => props.onPushToTalk(false)}
              onLostPointerCapture={() => props.onPushToTalk(false)}
              onKeyDown={(event) => {
                if (
                  (event.key === " " || event.key === "Enter") &&
                  !event.repeat
                ) {
                  event.preventDefault();
                  props.onPushToTalk(true);
                }
              }}
              onKeyUp={(event) => {
                if (event.key === " " || event.key === "Enter") {
                  event.preventDefault();
                  props.onPushToTalk(false);
                }
              }}
              onBlur={() => props.onPushToTalk(false)}
            >
              按住说话 · 松开发送停止
            </button>
          )}
          <AudioLevelControl
            id={`${id}-${location}-microphone`}
            label="我的麦克风发送增益"
            value={getMicrophoneGain(preferences, gainDeviceId)}
            maximum={200}
            disabled={!gainDeviceKnown}
            onChange={(gain) =>
              props.onPreferencesChange(
                withMicrophoneGain(preferences, gain, gainDeviceId),
              )
            }
          />
          {!gainDeviceKnown && (
            <p className="voice-panel__hint">
              实际麦克风尚未确认，暂以 100%
              发送。开启麦克风确认设备后可调节；新设备不会继承其他设备的增益。
            </p>
          )}
          <AudioMeter
            level={props.microphoneLevel ?? 0}
            label="麦克风发送电平"
            overloaded={props.microphoneOverloaded ?? false}
          />
          {props.microphoneOverloaded && (
            <p className="voice-panel__warning" role="status">
              声音过强，建议降低发送增益。
            </p>
          )}
          <p className="voice-panel__hint">
            数字增益不是系统麦克风音量。0%
            不等于停止采集；“关闭麦克风”才会释放设备。
          </p>
          <label
            className="voice-panel__device"
            htmlFor={`${id}-${location}-input`}
          >
            输入设备
          </label>
          <select
            id={`${id}-${location}-input`}
            value={preferences.inputDeviceId}
            onChange={(event) =>
              props.onPreferencesChange({
                ...preferences,
                inputDeviceId: event.target.value,
              })
            }
          >
            <option value="">系统默认麦克风</option>
            {preferences.inputDeviceId &&
              !props.inputDevices.some(
                (device) => device.deviceId === preferences.inputDeviceId,
              ) && (
                <option value={preferences.inputDeviceId}>
                  之前的麦克风（当前不可用）
                </option>
              )}
            {props.inputDevices
              .filter((device) =>
                isRememberableMicrophoneDevice(device.deviceId),
              )
              .map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `麦克风 ${index + 1}`}
                </option>
              ))}
          </select>
          <p className="voice-panel__hint">
            {props.channels === 2
              ? "当前采集：双声道"
              : props.channels === 1
                ? "当前采集：单声道"
                : "采集声道尚未确认"}{" "}
            · 不在本机回放自己的麦克风。
          </p>
        </section>
        <section
          className="voice-panel__others"
          aria-label="其他成员的收听音量"
        >
          <div className="voice-panel__section-heading">
            <span>我的收听</span>
            <small>{props.participants.length} 位成员</small>
          </div>
          {props.participants.length === 0 && (
            <p className="voice-panel__hint">
              其他成员入房后，可以在这里分别调节他们的声音。
            </p>
          )}
          {props.participants.length > 0 && (
            <p className="voice-panel__hint">
              100%
              为原始增益。提高音量也会放大噪声；软峰值保护不能保证消除所有爆音。
            </p>
          )}
          {props.participants.map((participant) => (
            <article
              className="voice-panel__channel"
              key={participant.id}
              data-speaking={participant.speaking}
            >
              <header className="voice-panel__channel-heading">
                <h3>{participant.nickname}</h3>
                <span className="voice-panel__participant-state">
                  {!participant.connected
                    ? "未连语音"
                    : participant.muted
                      ? "对方麦克风关闭"
                      : participant.speaking
                        ? "正在说话"
                        : "等待发言"}
                </span>
              </header>
              <AudioLevelControl
                id={`${id}-${location}-${participant.id}`}
                label={`${participant.nickname} 收听音量`}
                value={participant.volume}
                maximum={500}
                onChange={(volume) =>
                  props.onParticipantVolumeChange(participant.id, volume)
                }
              />
              <div className="voice-panel__channel-actions">
                <button
                  type="button"
                  onClick={() => toggleParticipant(participant)}
                  aria-pressed={participant.volume === 0}
                >
                  {participant.volume === 0
                    ? `恢复 ${participant.nickname} 声音`
                    : `静音 ${participant.nickname}`}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    props.onParticipantVolumeChange(participant.id, 100)
                  }
                  aria-label={`重置 ${participant.nickname} 收听音量为 100%`}
                >
                  重置 100%
                </button>
              </div>
              <AudioMeter
                level={participant.level ?? 0}
                label={`${participant.nickname} 收听电平`}
              />
              {!participant.accountId && (
                <p className="voice-panel__hint">
                  此成员的音量仅保留在本次房间。
                </p>
              )}
            </article>
          ))}
        </section>
        <details className="voice-panel__advanced">
          <summary>声音与设备选项</summary>
          <label htmlFor={`${id}-${location}-mode`}>麦克风处理模式</label>
          <select
            id={`${id}-${location}-mode`}
            value={preferences.mode}
            onChange={(event) =>
              props.onPreferencesChange({
                ...preferences,
                mode:
                  event.target.value === "original" ? "original" : "dialogue",
              })
            }
          >
            <option value="dialogue">对话优先（回声消除、降噪）</option>
            <option value="original">原声（建议佩戴耳机）</option>
          </select>
          <p className="voice-panel__hint">
            {preferences.mode === "original"
              ? "原声请求关闭浏览器回声消除、降噪与自动增益，仍保留软峰值保护；系统处理不一定关闭。请佩戴耳机，避免把影片声音传给别人。"
              : "对话模式请求回声消除、降噪与自动增益。实际支持由浏览器和设备决定。"}
          </p>
          <label className="voice-panel__check">
            <input
              type="checkbox"
              checked={preferences.pushToTalk}
              onChange={(event) =>
                props.onPreferencesChange({
                  ...preferences,
                  pushToTalk: event.target.checked,
                })
              }
            />
            使用按键说话
          </label>
          <p className="voice-panel__hint">
            记忆使用习惯，但每次入房仍需主动启用；待命时麦克风仍被占用。
          </p>
          <label className="voice-panel__check">
            <input
              type="checkbox"
              checked={preferences.autoDuck}
              onChange={(event) =>
                props.onPreferencesChange({
                  ...preferences,
                  autoDuck: event.target.checked,
                })
              }
            />
            有人说话时压低影片声音
          </label>
          <AudioLevelControl
            id={`${id}-${location}-program`}
            label="影片音量"
            value={preferences.programVolume}
            maximum={100}
            onChange={(programVolume) =>
              props.onPreferencesChange({ ...preferences, programVolume })
            }
          />
          <SystemAudioHelp />
          <p className="voice-panel__hint">
            设置只保存在当前账户的这个浏览器中，登出后保留。发送增益按实际麦克风记忆；新设备或设备标识变化从
            100% 开始。
          </p>
        </details>
        {props.diagnostics && (
          <details className="voice-panel__advanced">
            <summary>语音诊断</summary>
            <dl className="voice-panel__diagnostics">
              {props.diagnostics.map((item) => (
                <div key={item.label}>
                  <dt>{item.label}</dt>
                  <dd>{item.value}</dd>
                </div>
              ))}
            </dl>
            <p className="voice-panel__hint">
              96 kbps
              是编码目标，不是恒定实测速率；双声道以实际采集、协商和接收为准。
            </p>
          </details>
        )}
      </div>
    );
  }

  return (
    <div className="voice-panel">
      <section
        className="voice-panel__desktop"
        aria-labelledby={`${id}-desktop-title`}
      >
        {mixer("desktop")}
      </section>
      <div className="voice-panel__compact" aria-label="语音快捷操作">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-haspopup="dialog"
        >
          <span>同场声音</span>
          <small>
            {connectionText[connection]} · {preferences.callVolume}%
          </small>
        </button>
        <button
          type="button"
          onClick={props.onToggleMicrophone}
          disabled={microphoneDisabled}
          aria-pressed={capturing}
        >
          {capturing ? "关闭麦克风" : "开麦"}
        </button>
        {props.output !== "running" && connection === "connected" && (
          <button type="button" onClick={props.onEnableAudio}>
            启用声音
          </button>
        )}
      </div>
      <dialog
        ref={drawer}
        className="voice-panel__drawer"
        aria-labelledby={`${id}-mobile-title`}
        onClose={() => setExpanded(false)}
        onCancel={() => setExpanded(false)}
        onClick={(event) => {
          if (event.target === drawer.current) setExpanded(false);
        }}
      >
        <div className="voice-panel__drawer-inner">
          <button
            type="button"
            className="voice-panel__close"
            onClick={() => setExpanded(false)}
          >
            收起语音设置
          </button>
          {mixer("mobile")}
        </div>
      </dialog>
    </div>
  );
}

export function AudioLevelControl({
  id,
  label,
  value,
  maximum,
  disabled = false,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  maximum: 100 | 200 | 500;
  disabled?: boolean;
  onChange(value: number): void;
}) {
  const safeValue = Number.isFinite(value)
    ? Math.min(maximum, Math.max(0, value))
    : 100;
  return (
    <div className="voice-level" data-amplified={safeValue > 100}>
      <label htmlFor={id}>
        <span>{label}</span>
        <output htmlFor={id}>
          {safeValue}%{safeValue > 100 && <small> 增益</small>}
        </output>
      </label>
      <div
        className="voice-level__rail"
        style={
          { "--voice-unity": `${(100 / maximum) * 100}%` } as CSSProperties
        }
      >
        <input
          id={id}
          type="range"
          min={0}
          max={maximum}
          step={1}
          value={safeValue}
          disabled={disabled}
          aria-label={label}
          aria-valuetext={`${safeValue}%${safeValue > 100 ? "，增益区" : ""}`}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        {maximum > 100 && (
          <i className="voice-level__unity" aria-hidden="true" />
        )}
      </div>
      <div className="voice-level__scale" aria-hidden="true">
        <span>0</span>
        {maximum > 100 && (
          <span style={{ left: `${(100 / maximum) * 100}%` }}>100 · 原始</span>
        )}
        <span>{maximum}%</span>
      </div>
    </div>
  );
}

function AudioMeter({
  level,
  label,
  overloaded = false,
}: {
  level: number;
  label: string;
  overloaded?: boolean;
}) {
  const safe = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  return (
    <meter
      className="voice-panel__meter"
      aria-label={label}
      min={0}
      max={1}
      low={0.1}
      high={0.9}
      optimum={0.5}
      value={safe}
      data-overloaded={overloaded}
    >
      {Math.round(safe * 100)}%
    </meter>
  );
}

export function SystemAudioHelp() {
  return (
    <details className="voice-panel__system-help">
      <summary>系统麦克风效果说明</summary>
      <p>
        Apple
        设备可在使用麦克风时打开控制中心，查看当前浏览器提供的“自动、宽谱、语音突显”等选项。选项是否出现由系统、浏览器和输入设备决定，网页不能替你选择或确认这些模式。
      </p>
      <p>
        使用宽谱保留环境声时，可尝试本页“原声”模式；对话模式的降噪仍可能过滤这些声音。蓝牙耳机开麦也可能切换到较低音质的通话路径。
      </p>
      <p>
        Android
        使用浏览器支持的通用回声消除与降噪。三星、华为、小米、一加等系统效果请在系统中选择；这里不提供不存在的厂商通用开关。
      </p>
      <p>
        切到后台或锁屏可能中断声音。返回后按提示恢复语音；不会自动重新打开麦克风。
      </p>
    </details>
  );
}
