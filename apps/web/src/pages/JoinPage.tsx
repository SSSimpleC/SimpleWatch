import { type FormEvent, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { api, ApiError } from "../api.js";
import { useSession } from "../store.js";

export function JoinPage() {
  const { inviteToken = "" } = useParams();
  const navigate = useNavigate();
  const { setRoomCsrf, setMemberId } = useSession();
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      const result = await api<{
        room: { id: string };
        member: { id: string };
        csrfToken: string;
      }>("/api/v1/rooms/active/join", {
        method: "POST",
        body: JSON.stringify({
          nickname: data.get("nickname"),
          inviteToken,
        }),
      });
      setRoomCsrf(result.csrfToken);
      setMemberId(result.member.id);
      void navigate(`/room/${result.room.id}`, { replace: true });
    } catch (joinError) {
      setError(
        joinError instanceof ApiError ? joinError.message : "无法加入放映室",
      );
      setSubmitting(false);
    }
  }

  return (
    <main className="room-shell join-room-shell">
      <Link to="/" className="brand-mark">
        SW / 门厅
      </Link>
      <form className="admission-card" onSubmit={join}>
        <p className="eyebrow">FRIENDS ONLY / ONE SEAT</p>
        <h1>报上名字，领取座位。</h1>
        <label>
          昵称
          <input
            name="nickname"
            required
            maxLength={24}
            autoFocus
            autoComplete="nickname"
          />
        </label>
        <button type="submit" disabled={submitting}>
          {submitting ? "正在入场…" : "进入放映室"}
        </button>
        <output aria-live="polite">{error}</output>
      </form>
    </main>
  );
}
