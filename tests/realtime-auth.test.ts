import { createHmac } from "node:crypto";

import { describe, expect, test } from "vitest";

import { verifyTelegramInitData } from "../src/core/realtime/telegram-auth.js";

function signInitData(fields: Record<string, string>, botToken: string): string {
  const params = new URLSearchParams(fields);
  const entries = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();
  const hash = createHmac("sha256", secret)
    .update(entries)
    .digest("hex");
  params.set("hash", hash);
  return params.toString();
}

describe("verifyTelegramInitData", () => {
  test("accepts signed Telegram init data", () => {
    const botToken = "123:ABC";
    const nowMs = 1_700_000_000_000;
    const initData = signInitData({
      auth_date: String(Math.floor(nowMs / 1000)),
      chat_instance: "ci-1",
      user: JSON.stringify({ id: 42, first_name: "TestUser" }),
    }, botToken);

    expect(verifyTelegramInitData(initData, botToken, { nowMs })).toEqual({
      userId: "42",
      chatInstance: "ci-1",
    });
  });

  test("rejects tampered init data", () => {
    const botToken = "123:ABC";
    const nowMs = 1_700_000_000_000;
    const initData = signInitData({
      auth_date: String(Math.floor(nowMs / 1000)),
      chat_instance: "ci-1",
      user: JSON.stringify({ id: 42, first_name: "TestUser" }),
    }, botToken).replace("TestUser", "TamperedUser");

    expect(() => verifyTelegramInitData(initData, botToken, { nowMs })).toThrow(/hash mismatch/i);
  });

  test("rejects expired init data", () => {
    const botToken = "123:ABC";
    const nowMs = 1_700_000_000_000;
    const initData = signInitData({
      auth_date: String(Math.floor(nowMs / 1000) - 601),
      chat_instance: "ci-1",
      user: JSON.stringify({ id: 42, first_name: "TestUser" }),
    }, botToken);

    expect(() => verifyTelegramInitData(initData, botToken, { nowMs, maxAgeSeconds: 600 })).toThrow(/expired/i);
  });

  test("rejects malformed hash values cleanly", () => {
    const botToken = "123:ABC";
    const nowMs = 1_700_000_000_000;
    const initData = signInitData({
      auth_date: String(Math.floor(nowMs / 1000)),
      chat_instance: "ci-1",
      user: JSON.stringify({ id: 42, first_name: "TestUser" }),
    }, botToken).replace(/hash=[^&]+/, "hash=abc");

    expect(() => verifyTelegramInitData(initData, botToken, { nowMs })).toThrow(/hash mismatch/i);
  });
});
