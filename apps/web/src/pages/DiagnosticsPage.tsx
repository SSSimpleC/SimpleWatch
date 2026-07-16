import { useState } from "react";
import { Link } from "react-router-dom";

export function DiagnosticsPage() {
  const [copied, setCopied] = useState(false);
  const connection = (
    navigator as Navigator & {
      connection?: { effectiveType?: string; downlink?: number; rtt?: number };
    }
  ).connection;
  const report = {
    generatedAt: new Date().toISOString(),
    online: navigator.onLine,
    effectiveType: connection?.effectiveType ?? "unknown",
    downlinkMbps: connection?.downlink ?? null,
    rttMs: connection?.rtt ?? null,
    userAgent: navigator.userAgent.replace(/\([^)]*\)/g, "(redacted)"),
    roomState:
      sessionStorage.getItem("simplewatch.room-state") ?? "not-connected",
    programState:
      sessionStorage.getItem("simplewatch.program-diagnostics") ??
      "not-playing",
    liveState:
      sessionStorage.getItem("simplewatch.live-diagnostics") ?? "not-live",
  };
  return (
    <main className="console-shell settings-shell">
      <Link to="/" className="brand-mark">
        SW / 门厅
      </Link>
      <section className="panel settings-panel">
        <p className="eyebrow">REDACTED REPORT</p>
        <h1>连接诊断</h1>
        <dl className="diagnostic-grid">
          <dt>浏览器在线</dt>
          <dd>{report.online ? "是" : "否"}</dd>
          <dt>网络类型</dt>
          <dd>{report.effectiveType}</dd>
          <dt>估算 RTT</dt>
          <dd>{report.rttMs ?? "—"} ms</dd>
          <dt>下行</dt>
          <dd>{report.downlinkMbps ?? "—"} Mbps</dd>
          <dt>房间状态</dt>
          <dd>{report.roomState}</dd>
          <dt>节目状态</dt>
          <dd>{report.programState}</dd>
          <dt>直播链路</dt>
          <dd>{report.liveState}</dd>
        </dl>
        <button
          onClick={() =>
            void navigator.clipboard
              .writeText(JSON.stringify(report, null, 2))
              .then(() => setCopied(true))
              .catch(() => setCopied(false))
          }
        >
          {copied ? "已复制脱敏报告" : "复制脱敏报告"}
        </button>
        <p className="muted-copy">
          报告不包含 Cookie、JWT、房间密码、SDP 或 ICE 候选。
        </p>
      </section>
    </main>
  );
}
