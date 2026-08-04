export function fullJitterBackoff(
  attempt: number,
  random: () => number = Math.random,
  minimumMs = 1_000,
  maximumMs = 15 * 60 * 1000,
): number {
  const boundedAttempt = Math.max(0, Math.min(30, Math.trunc(attempt)));
  const ceiling = Math.min(maximumMs, minimumMs * 2 ** boundedAttempt);
  const sample = Math.max(0, Math.min(1, random()));
  return Math.min(ceiling, Math.floor(sample * ceiling));
}

export function delay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(abortReason(signal));
      },
      { once: true },
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("操作已取消", "AbortError");
}
