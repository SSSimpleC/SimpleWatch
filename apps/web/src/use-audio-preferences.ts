import { useCallback, useSyncExternalStore, type SetStateAction } from "react";

import {
  clearAudioPreferences,
  loadPreferences,
  savePreferences,
  subscribeAudioPreferences,
  type AudioPreferences,
} from "./preferences.js";

/** Account switches never render the previous account's cached preferences. */
export function useAudioPreferences(accountId: string | null | undefined) {
  const getSnapshot = useCallback(
    () => loadPreferences(accountId),
    [accountId],
  );
  const preferences = useSyncExternalStore(
    subscribeAudioPreferences,
    getSnapshot,
    () => loadPreferences(null),
  );
  const setPreferences = useCallback(
    (update: SetStateAction<AudioPreferences>) => {
      if (!accountId) return;
      const current = loadPreferences(accountId);
      savePreferences(
        typeof update === "function" ? update(current) : update,
        accountId,
      );
    },
    [accountId],
  );
  return { preferences, setPreferences, clearAudioPreferences };
}
