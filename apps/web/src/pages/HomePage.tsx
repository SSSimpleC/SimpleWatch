import { Link } from "react-router-dom";

export function HomePage() {
  return (
    <main className="landing">
      <div className="grain" aria-hidden="true" />
      <header className="masthead">
        <span className="brand-mark">SW / 01</span>
        <Link to="/admin" className="text-link">
          放映员入口 ↗
        </Link>
      </header>
      <section className="hero">
        <p className="eyebrow">PRIVATE SYNCHRONIZED SCREENING</p>
        <h1>
          让远方的人，
          <br />
          <em>坐进同一排座位。</em>
        </h1>
        <p className="lede">
          一间只属于五个人的同步放映室。影片、直播、声音与字幕，在同一时刻抵达。
        </p>
        <div className="invite-note">
          <span>INVITATION ONLY</span>
          <strong>请从好友发送的专属链接入场</strong>
          <small>链接打开后只需输入昵称，不需要房间编号或口令。</small>
        </div>
      </section>
      <footer className="landing-footer">
        <span>H.264 / H.265 MP4</span>
        <span>最多 5 席</span>
        <span>端到端会话鉴权</span>
      </footer>
    </main>
  );
}
