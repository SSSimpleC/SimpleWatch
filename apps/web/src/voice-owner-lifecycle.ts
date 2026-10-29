// Module scope intentionally spans RoomPage unmount/remount in this browser tab.
// Web Locks still arbitrate other tabs; this registry only waits for our own cleanup.
const releases = new Map<string, Promise<void>>();

export function waitForVoiceOwnerRelease(accountId: string): Promise<void> {
  return releases.get(accountId) ?? Promise.resolve();
}

export function trackVoiceOwnerRelease(
  accountId: string,
  release: Promise<void>,
): Promise<void> {
  const completion = Promise.all([releases.get(accountId), release]).then(
    () => undefined,
  );
  releases.set(accountId, completion);
  const done = () => {
    if (releases.get(accountId) === completion) releases.delete(accountId);
  };
  void completion.then(done, done);
  return completion;
}
