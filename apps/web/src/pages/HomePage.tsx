import { type FormEvent, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  api,
  ApiError,
  type AccountDestination,
  type AccountSession,
} from "../api.js";
import { useSession } from "../store.js";

export function HomePage() {
  const navigate = useNavigate();
  const { account, setAccount, setAdminCsrf, setMemberId, clear } =
    useSession();
  const [destination, setDestination] = useState<AccountDestination | null>(
    null,
  );
  const [checking, setChecking] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const sourceRef = useRef<EventSource | null>(null);

  function acceptSession(session: AccountSession) {
    setAccount(session.account);
    setAdminCsrf(session.csrfToken);
    setDestination(session.destination);
    routeDestination(session.destination);
  }

  function routeDestination(next: AccountDestination) {
    if (next.state === "admin") {
      void navigate("/admin", { replace: true });
      return;
    }
    if (next.state === "room") {
      setMemberId(next.memberId);
      void navigate(`/room/${next.roomId}`, { replace: true });
    }
  }

  useEffect(() => {
    let active = true;
    void api<AccountSession>("/api/v1/auth/session")
      .then((session) => {
        if (active) acceptSession(session);
      })
      .catch(() => {
        if (active) clear();
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
    if (!account || destination?.state !== "waiting") return;
    const source = new EventSource("/api/v1/lobby/events", {
      withCredentials: true,
    });
    sourceRef.current = source;
    source.addEventListener("room-state", (event) => {
      const next = JSON.parse(
        (event as MessageEvent<string>).data,
      ) as AccountDestination;
      setDestination(next);
      routeDestination(next);
    });
    source.addEventListener("session-expired", () => {
      source.close();
      clear();
      setDestination(null);
      setMessage("登录已过期，请重新验证账户");
    });
    return () => source.close();
  }, [account?.id, destination?.state]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setMessage("");
    const data = new FormData(event.currentTarget);
    try {
      const session = await api<AccountSession>("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({
          username: data.get("username"),
          password: data.get("password"),
        }),
      });
      event.currentTarget.reset();
      acceptSession(session);
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : "登录失败");
    } finally {
      setSubmitting(false);
      setChecking(false);
    }
  }

  async function takeover() {
    try {
      const next = await api<AccountDestination>("/api/v1/room/takeover", {
        method: "POST",
        body: "{}",
      });
      setDestination(next);
      routeDestination(next);
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : "接管席位失败");
    }
  }

  async function logout() {
    const csrf = useSession.getState().adminCsrf;
    if (csrf) {
      await api<void>("/api/v1/auth/logout", {
        method: "POST",
        headers: { "x-csrf-token": csrf },
        body: "{}",
      }).catch(() => undefined);
    }
    clear();
    setDestination(null);
  }

  const waitingCopy = destination
    ? waitingText(destination)
    : { title: "正在核验", body: "请稍候。" };
  return (
    <main className="landing auth-landing">
      <div className="grain" aria-hidden="true" />
      <header className="masthead">
        <span className="brand-mark">SW / PRIVATE SCREENING</span>
        <span className="security-stamp">SECURE SEAT ACCESS</span>
      </header>
      <section className="auth-stage">
        <div className="auth-intro">
          <p className="eyebrow">PRIVATE SYNCHRONIZED SCREENING</p>
          <h1>
            入场凭证，
            <br />
            <em>就是你的座位。</em>
          </h1>
          <p className="lede">
            固定账户对应固定席位。登录后，影片、直播与通话会在房间开放时自动接通。
          </p>
        </div>

        {checking ? (
          <section className="ticket-card waiting-card" aria-live="polite">
            <span className="ticket-number">VERIFYING</span>
            <h2>正在核验上次入场记录</h2>
            <div className="waiting-pulse" aria-hidden="true" />
          </section>
        ) : account && destination ? (
          <section className="ticket-card waiting-card" aria-live="polite">
            <span className="ticket-number">SEAT / {account.username}</span>
            <h2>{waitingCopy.title}</h2>
            <p>{waitingCopy.body}</p>
            {destination.state === "waiting" && destination.position && (
              <strong className="queue-number">
                等待序号 {destination.position}
              </strong>
            )}
            {destination.state === "taken-over" && (
              <button type="button" onClick={() => void takeover()}>
                在本设备接管席位
              </button>
            )}
            <button
              className="text-button"
              type="button"
              onClick={() => void logout()}
            >
              退出账户
            </button>
            <output>{message}</output>
          </section>
        ) : (
          <form className="ticket-card login-ticket" onSubmit={login}>
            <span className="ticket-number">ADMIT ONE / ACCOUNT REQUIRED</span>
            <h2>验证观影席</h2>
            <label>
              账户名称
              <input
                name="username"
                required
                maxLength={64}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                autoFocus
              />
            </label>
            <label>
              账户密码
              <input
                name="password"
                type="password"
                required
                maxLength={128}
                autoComplete="current-password"
              />
            </label>
            <button type="submit" disabled={submitting}>
              {submitting ? "正在核验…" : "凭证入场 →"}
            </button>
            <output aria-live="polite">{message}</output>
            <small>会话闲置 7 日失效，连续使用最长 30 日后重新验证。</small>
          </form>
        )}
      </section>
      <footer className="landing-footer">
        <span>固定账户</span>
        <span>最多 5 席</span>
        <span>端到端会话鉴权</span>
      </footer>
    </main>
  );
}

function waitingText(destination: AccountDestination) {
  if (destination.state === "taken-over") {
    return {
      title: "席位正在另一台设备使用",
      body: "你仍保持登录。需要在这里观看时，请主动接管席位。",
    };
  }
  if (destination.state !== "waiting") {
    return { title: "正在进入放映室", body: "请稍候。" };
  }
  if (destination.reason === "room-full") {
    return {
      title: "当前五席已满",
      body: "有席位释放后，本页面会自动为你入场。",
    };
  }
  if (destination.reason === "removed") {
    return {
      title: "本场席位已被移出",
      body: "当前场次结束后，下次开房可再次进入。",
    };
  }
  if (destination.reason === "left") {
    return {
      title: "你已主动离开本场",
      body: "本场不再自动进入；下次开房会恢复。",
    };
  }
  return {
    title: "放映室尚未开放",
    body: "保持此页即可；Host 开房后会自动入场。",
  };
}
