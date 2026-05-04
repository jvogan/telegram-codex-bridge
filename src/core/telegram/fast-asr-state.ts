export const TELEGRAM_FAST_ASR_NEXT_KEY = "telegram:fast_asr_next";
export const TELEGRAM_FAST_ASR_UNTIL_KEY = "telegram:fast_asr_until";
export const FAST_ASR_PREFERENCE_WINDOW_MS = 30 * 60_000;

export interface FastAsrPreferenceStore {
  getSetting<T>(key: string, fallback: T): T;
  setSetting<T>(key: string, value: T): void;
}

export function consumeFastAsrPreference(
  store: FastAsrPreferenceStore,
  now = Date.now(),
): boolean {
  const oneShot = store.getSetting<boolean>(TELEGRAM_FAST_ASR_NEXT_KEY, false);
  const activeUntil = store.getSetting<number>(TELEGRAM_FAST_ASR_UNTIL_KEY, 0);
  if (activeUntil > 0 && activeUntil <= now) {
    if (oneShot) {
      store.setSetting(TELEGRAM_FAST_ASR_NEXT_KEY, false);
    }
    store.setSetting(TELEGRAM_FAST_ASR_UNTIL_KEY, 0);
    return false;
  }

  if (oneShot) {
    store.setSetting(TELEGRAM_FAST_ASR_NEXT_KEY, false);
  }

  return oneShot || activeUntil > now;
}

export function clearExpiredFastAsrPreference(
  store: FastAsrPreferenceStore,
  now = Date.now(),
): boolean {
  const activeUntil = store.getSetting<number>(TELEGRAM_FAST_ASR_UNTIL_KEY, 0);
  if (activeUntil <= 0 || activeUntil > now) {
    return false;
  }
  store.setSetting(TELEGRAM_FAST_ASR_NEXT_KEY, false);
  store.setSetting(TELEGRAM_FAST_ASR_UNTIL_KEY, 0);
  return true;
}

export function armFastAsrPreference(
  store: FastAsrPreferenceStore,
  now = Date.now(),
  windowMs = FAST_ASR_PREFERENCE_WINDOW_MS,
): number {
  const activeUntil = now + windowMs;
  store.setSetting(TELEGRAM_FAST_ASR_NEXT_KEY, true);
  store.setSetting(TELEGRAM_FAST_ASR_UNTIL_KEY, activeUntil);
  return activeUntil;
}
