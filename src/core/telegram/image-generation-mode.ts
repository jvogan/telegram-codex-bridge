export type TelegramImageGenerationMode = "bridge-direct" | "codex-native";

export const TELEGRAM_IMAGE_GENERATION_MODE_KEY = "telegram:image_generation_mode";

interface SettingReader {
  getSetting<T>(key: string, fallback: T): T;
}

export function normalizeTelegramImageGenerationMode(value: unknown): TelegramImageGenerationMode {
  return value === "codex-native" ? "codex-native" : "bridge-direct";
}

export function telegramImageGenerationMode(state: SettingReader): TelegramImageGenerationMode {
  if (process.env.TELEGRAM_IMAGE_GENERATION_MODE !== undefined) {
    return normalizeTelegramImageGenerationMode(process.env.TELEGRAM_IMAGE_GENERATION_MODE);
  }
  return normalizeTelegramImageGenerationMode(
    state.getSetting<string>(TELEGRAM_IMAGE_GENERATION_MODE_KEY, "bridge-direct"),
  );
}
