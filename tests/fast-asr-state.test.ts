import { describe, expect, test } from "vitest";

import {
  armFastAsrPreference,
  clearExpiredFastAsrPreference,
  consumeFastAsrPreference,
  FAST_ASR_PREFERENCE_WINDOW_MS,
  TELEGRAM_FAST_ASR_NEXT_KEY,
  TELEGRAM_FAST_ASR_UNTIL_KEY,
  type FastAsrPreferenceStore,
} from "../src/core/telegram/fast-asr-state.js";

class MemoryStore implements FastAsrPreferenceStore {
  private readonly values = new Map<string, unknown>();

  getSetting<T>(key: string, fallback: T): T {
    return (this.values.has(key) ? this.values.get(key) : fallback) as T;
  }

  setSetting<T>(key: string, value: T): void {
    this.values.set(key, value);
  }
}

describe("fast ASR preference state", () => {
  test("arms a one-shot flag and rolling preference window", () => {
    const store = new MemoryStore();
    const now = 1_000;

    expect(armFastAsrPreference(store, now)).toBe(now + FAST_ASR_PREFERENCE_WINDOW_MS);
    expect(store.getSetting(TELEGRAM_FAST_ASR_NEXT_KEY, false)).toBe(true);
    expect(store.getSetting(TELEGRAM_FAST_ASR_UNTIL_KEY, 0)).toBe(now + FAST_ASR_PREFERENCE_WINDOW_MS);
  });

  test("consumes one-shot fast ASR without clearing an active window", () => {
    const store = new MemoryStore();
    armFastAsrPreference(store, 1_000, 10_000);

    expect(consumeFastAsrPreference(store, 2_000)).toBe(true);
    expect(store.getSetting(TELEGRAM_FAST_ASR_NEXT_KEY, true)).toBe(false);
    expect(consumeFastAsrPreference(store, 5_000)).toBe(true);
  });

  test("expires stale fast ASR windows instead of staying armed forever", () => {
    const store = new MemoryStore();
    store.setSetting(TELEGRAM_FAST_ASR_NEXT_KEY, true);
    store.setSetting(TELEGRAM_FAST_ASR_UNTIL_KEY, 2_000);

    expect(consumeFastAsrPreference(store, 2_001)).toBe(false);
    expect(store.getSetting(TELEGRAM_FAST_ASR_NEXT_KEY, true)).toBe(false);
    expect(store.getSetting(TELEGRAM_FAST_ASR_UNTIL_KEY, 1)).toBe(0);
  });

  test("clears expired fast ASR state during startup health cleanup", () => {
    const store = new MemoryStore();
    store.setSetting(TELEGRAM_FAST_ASR_NEXT_KEY, true);
    store.setSetting(TELEGRAM_FAST_ASR_UNTIL_KEY, 2_000);

    expect(clearExpiredFastAsrPreference(store, 2_001)).toBe(true);
    expect(store.getSetting(TELEGRAM_FAST_ASR_NEXT_KEY, true)).toBe(false);
    expect(store.getSetting(TELEGRAM_FAST_ASR_UNTIL_KEY, 1)).toBe(0);
    expect(clearExpiredFastAsrPreference(store, 2_002)).toBe(false);
  });
});
