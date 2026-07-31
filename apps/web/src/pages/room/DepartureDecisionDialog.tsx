import { useEffect, useRef } from "react";

import type { DepartureDecision } from "../../room-program.js";

export function DepartureDecisionDialog({
  open,
  currentTitle,
  targetTitle,
  coveredRatio,
  returnFocus,
  onDecision,
  onCancel,
}: {
  readonly open: boolean;
  readonly currentTitle: string;
  readonly targetTitle: string;
  readonly coveredRatio: number | null;
  readonly returnFocus: HTMLButtonElement | null;
  readonly onDecision: (decision: DepartureDecision) => void;
  readonly onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      window.requestAnimationFrame(() => primaryRef.current?.focus());
    } else if (!open && dialog.open) {
      dialog.close();
      window.setTimeout(() => returnFocus?.focus(), 0);
    }
  }, [open, returnFocus]);

  return (
    <dialog
      ref={dialogRef}
      className="departure-dialog"
      role="alertdialog"
      aria-labelledby="departure-dialog-title"
      aria-describedby="departure-dialog-copy"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <div className="departure-dialog-mark" aria-hidden="true">
        90
      </div>
      <p className="eyebrow">REEL CHANGE / 观看记录</p>
      <h2 id="departure-dialog-title">这一集还没有看完。</h2>
      <p id="departure-dialog-copy">
        《{currentTitle || "当前影片"}》已记录{" "}
        <strong>
          {coveredRatio === null
            ? "不足 90%"
            : Math.round(coveredRatio * 100) + "%"}
        </strong>
        。现在切到《{targetTitle}》前，请决定如何保存本次观看。
      </p>
      <div className="departure-dialog-choices">
        <button
          ref={primaryRef}
          type="button"
          onClick={() => onDecision("confirm-complete")}
        >
          <span>确认已看完并切换</span>
          <small>把当前影片记为已完成</small>
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => onDecision("continue-incomplete")}
        >
          <span>保留未完并切换</span>
          <small>保留进度，稍后还可以回来</small>
        </button>
      </div>
      <button
        type="button"
        className="text-button departure-dialog-cancel"
        onClick={onCancel}
      >
        取消，继续当前影片
      </button>
    </dialog>
  );
}
