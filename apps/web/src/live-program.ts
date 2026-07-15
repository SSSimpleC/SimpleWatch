export type ProgramTrack = {
  readonly id: string;
  readonly kind: string;
  readonly readyState: string;
};

export type ProgramTrackDecision = "accept" | "same" | "reject-duplicate";

export function decideProgramTrack(
  existing: ProgramTrack | undefined,
  incoming: ProgramTrack,
): ProgramTrackDecision {
  if (!existing) return "accept";
  if (existing.id === incoming.id) return "same";
  return existing.readyState === "live" ? "reject-duplicate" : "accept";
}

export function replaceRetryTimer(
  currentTimer: number,
  clearTimer: (timer: number) => void,
  schedule: (callback: () => void, delayMs: number) => number,
  callback: () => void,
  delayMs: number,
): number {
  if (currentTimer) clearTimer(currentTimer);
  return schedule(callback, delayMs);
}
