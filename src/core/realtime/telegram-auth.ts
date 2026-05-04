import { createHmac, timingSafeEqual } from "node:crypto";

interface VerifiedTelegramInitData {
  userId: string | null;
  chatInstance: string | null;
}

interface VerifyTelegramInitDataOptions {
  maxAgeSeconds?: number;
  nowMs?: number;
}

function buildDataCheckString(initData: URLSearchParams): string {
  const entries = [...initData.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`);
  return entries.join("\n");
}

export function verifyTelegramInitData(
  initDataRaw: string,
  botToken: string,
  options: VerifyTelegramInitDataOptions = {},
): VerifiedTelegramInitData {
  const initData = new URLSearchParams(initDataRaw);
  const hash = initData.get("hash");
  if (!hash) {
    throw new Error("Telegram init data is missing the hash.");
  }
  const authDate = Number.parseInt(initData.get("auth_date") ?? "", 10);
  if (!Number.isFinite(authDate) || authDate <= 0) {
    throw new Error("Telegram init data is missing a valid auth_date.");
  }
  const maxAgeSeconds = options.maxAgeSeconds ?? 300;
  const nowMs = options.nowMs ?? Date.now();
  if ((nowMs / 1000) - authDate > maxAgeSeconds) {
    throw new Error("Telegram init data has expired.");
  }
  const secret = createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();
  const check = createHmac("sha256", secret)
    .update(buildDataCheckString(initData))
    .digest("hex");
  const expected = Buffer.from(check, "hex");
  const actual = Buffer.from(hash, "hex");
  if (expected.length === 0 || actual.length === 0 || expected.length !== actual.length) {
    throw new Error("Telegram init data hash mismatch.");
  }
  if (!timingSafeEqual(expected, actual)) {
    throw new Error("Telegram init data hash mismatch.");
  }
  const userRaw = initData.get("user");
  let userId: string | null = null;
  if (userRaw) {
    try {
      const parsed = JSON.parse(userRaw) as { id?: number | string };
      if (parsed.id !== undefined) {
        userId = String(parsed.id);
      }
    } catch {
      userId = null;
    }
  }
  return {
    userId,
    chatInstance: initData.get("chat_instance"),
  };
}
