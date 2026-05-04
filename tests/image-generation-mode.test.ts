import { afterEach, describe, expect, test } from "vitest";

import {
  TELEGRAM_IMAGE_GENERATION_MODE_KEY,
  normalizeTelegramImageGenerationMode,
  telegramImageGenerationMode,
} from "../src/core/telegram/image-generation-mode.js";

describe("Telegram image generation mode", () => {
  const originalEnv = process.env.TELEGRAM_IMAGE_GENERATION_MODE;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.TELEGRAM_IMAGE_GENERATION_MODE;
    } else {
      process.env.TELEGRAM_IMAGE_GENERATION_MODE = originalEnv;
    }
  });

  test("normalizes unknown values to bridge-direct", () => {
    expect(normalizeTelegramImageGenerationMode("codex-native")).toBe("codex-native");
    expect(normalizeTelegramImageGenerationMode("openai")).toBe("bridge-direct");
    expect(normalizeTelegramImageGenerationMode(undefined)).toBe("bridge-direct");
  });

  test("reads codex-native from state", () => {
    delete process.env.TELEGRAM_IMAGE_GENERATION_MODE;
    const state = {
      getSetting<T>(key: string, fallback: T): T {
        return key === TELEGRAM_IMAGE_GENERATION_MODE_KEY ? "codex-native" as T : fallback;
      },
    };
    expect(telegramImageGenerationMode(state)).toBe("codex-native");
  });

  test("defaults fresh state to bridge-direct", () => {
    delete process.env.TELEGRAM_IMAGE_GENERATION_MODE;
    const state = {
      getSetting<T>(_key: string, fallback: T): T {
        return fallback;
      },
    };
    expect(telegramImageGenerationMode(state)).toBe("bridge-direct");
  });

  test("allows env override in either direction", () => {
    process.env.TELEGRAM_IMAGE_GENERATION_MODE = "codex-native";
    const state = {
      getSetting<T>(_key: string, fallback: T): T {
        return fallback;
      },
    };
    expect(telegramImageGenerationMode(state)).toBe("codex-native");

    process.env.TELEGRAM_IMAGE_GENERATION_MODE = "bridge-direct";
    expect(telegramImageGenerationMode({
      getSetting<T>(key: string, fallback: T): T {
        return key === TELEGRAM_IMAGE_GENERATION_MODE_KEY ? "codex-native" as T : fallback;
      },
    })).toBe("bridge-direct");
  });
});
