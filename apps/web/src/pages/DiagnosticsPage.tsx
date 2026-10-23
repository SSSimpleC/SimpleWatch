import { useState } from "react";
import { Link } from "react-router";
import { PLAYER_BUILD } from "../player-build.js";
import {
  browserReportStorage,
  readPlayerReportStorage,
  serializePlayerReport,
} from "../player-report.js";

export function DiagnosticsPage() {
  const [copied, setCopied] = useState(false);
  const [fallbackReport, setFallbackReport] = useState("");
  const report = serializePlayerReport({
    buildId: PLAYER_BUILD,
    online: navigator.onLine,
    visibility: document.visibilityState,
    ...readPlayerReportStorage(browserReportStorage()),
  });
  function copyReport() {
    const fallback = () => {
      setCopied(false);
      setFallbackReport(report);
    };
    try {
      void navigator.clipboard
        .writeText(report)
        .then(() => {
          setCopied(true);
          setFallbackReport("");
        })
        .catch(fallback);
    } catch {
      fallback();
    }
  }
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
          <dd>{navigator.onLine ? "是" : "否"}</dd>
          <dt>播放器版本</dt>
          <dd>{PLAYER_BUILD.slice(0, 12)}</dd>
        </dl>
        <p>
          这里显示离开房间前的本机快照；连续播放排查请优先在房间内“播放诊断”直接复制，避免中断现场。
        </p>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {report}
        </pre>
        <button onClick={copyReport}>
          {copied ? "已复制脱敏报告" : "复制脱敏报告"}
        </button>
        {fallbackReport && (
          <textarea
            aria-label="脱敏播放报告"
            readOnly
            value={fallbackReport}
            rows={8}
            style={{ width: "100%" }}
            onFocus={(event) => event.currentTarget.select()}
          />
        )}
        <p className="muted-copy">
          报告不包含账户、房间或影片标识、文件路径、URL、Cookie、JWT、SDP 或 ICE
          候选；不会自动上传。
        </p>
      </section>
    </main>
  );
}
