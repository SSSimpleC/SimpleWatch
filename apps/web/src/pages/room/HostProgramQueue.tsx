import type {
  EdgeTransfer,
  ProgramQueue,
  ProgramQueueItem,
} from "@simplewatch/contracts";

import { playbackStateLabel, programRelayStatus } from "../../room-program.js";

export function HostProgramQueue({
  program,
  transfers,
  loading,
  error,
  pendingItemId,
  onActivate,
}: {
  readonly program: ProgramQueue | null | undefined;
  readonly transfers: readonly EdgeTransfer[];
  readonly loading: boolean;
  readonly error: unknown;
  readonly pendingItemId: string | null;
  readonly onActivate: (
    item: ProgramQueueItem,
    trigger: HTMLButtonElement,
  ) => void;
}) {
  return (
    <section
      className="room-program-queue"
      aria-labelledby="room-program-title"
      aria-busy={loading}
    >
      <header>
        <div>
          <span>PROGRAM RUN / EDGE RELAY</span>
          <h2 id="room-program-title">今晚的接片单</h2>
        </div>
        {program && <b>REV {program.revision}</b>}
      </header>
      {loading && (
        <p className="room-program-notice" role="status">
          正在从云端任务账本读取节目状态…
        </p>
      )}
      {Boolean(error) && (
        <p className="room-program-notice error" role="alert">
          节目单暂时不可用；当前影片不受影响，稍后会自动重试。
        </p>
      )}
      {!loading && !error && (!program || program.items.length === 0) && (
        <p className="room-program-notice">
          节目单还是空的。请从放映控制的家庭片库加入完整影片。
        </p>
      )}
      {program && program.items.length > 0 && (
        <ol className="room-program-rundown">
          {program.items.map((item) => {
            const relay = programRelayStatus(item, transfers);
            const current = item.id === program.currentItemId;
            const pending = item.id === pendingItemId;
            const canActivate =
              !current &&
              item.preparationState === "ready" &&
              Boolean(item.mediaId) &&
              !pendingItemId;
            return (
              <li
                key={item.id}
                className={
                  "room-program-card tone-" +
                  relay.tone +
                  (current ? " current" : "")
                }
                aria-current={current ? "true" : undefined}
              >
                <span className="room-program-index">
                  {String(item.position + 1).padStart(2, "0")}
                </span>
                <div className="room-program-copy">
                  <small>
                    {playbackStateLabel(item.playbackState)}
                    {item.watchCoverage
                      ? " · " +
                        Math.round(item.watchCoverage.coveredRatio * 100) +
                        "%"
                      : ""}
                  </small>
                  <strong title={item.displayName}>{item.displayName}</strong>
                  <span className="room-program-state" aria-live="polite">
                    <i />
                    {relay.label}
                  </span>
                  <em>{relay.eta ?? "等待新的传输进度"}</em>
                </div>
                <button
                  type="button"
                  className="room-program-action"
                  disabled={!canActivate}
                  onClick={(event) => onActivate(item, event.currentTarget)}
                >
                  {current
                    ? "当前节目"
                    : pending
                      ? "正在切换"
                      : item.preparationState === "ready"
                        ? "切到此片"
                        : "等待就绪"}
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
