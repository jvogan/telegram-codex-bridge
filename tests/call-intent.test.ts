import { describe, expect, test } from "vitest";

import { detectTelegramCallIntent, normalizeTelegramCallIntentText } from "../src/core/realtime/call-intent.js";

describe("telegram live-call intent detection", () => {
  test("normalizes short Telegram phrases for matching", () => {
    expect(normalizeTelegramCallIntentText("  Call me, please.  ")).toBe("call me please");
  });

  test("detects launch requests", () => {
    expect(detectTelegramCallIntent("call")).toBe("launch");
    expect(detectTelegramCallIntent("call me")).toBe("launch");
    expect(detectTelegramCallIntent("hey, give me a call")).toBe("launch");
    expect(detectTelegramCallIntent("could you give me a quick call")).toBe("launch");
    expect(detectTelegramCallIntent("let's hop on a call")).toBe("launch");
    expect(detectTelegramCallIntent("arm call")).toBe("launch");
    expect(detectTelegramCallIntent("enable live calling")).toBe("launch");
    expect(detectTelegramCallIntent("please open the live call")).toBe("launch");
    expect(detectTelegramCallIntent("could you start a call")).toBe("launch");
    expect(detectTelegramCallIntent("call me, please")).toBe("launch");
    expect(detectTelegramCallIntent("give me a call please")).toBe("launch");
    expect(detectTelegramCallIntent("start a live call when ready")).toBe("launch");
  });

  test("detects status requests", () => {
    expect(detectTelegramCallIntent("call status")).toBe("status");
    expect(detectTelegramCallIntent("is the live call ready")).toBe("status");
  });

  test("avoids false positives for general conversation", () => {
    expect(detectTelegramCallIntent("I will call you later")).toBeNull();
    expect(detectTelegramCallIntent("this API call is failing")).toBeNull();
    expect(detectTelegramCallIntent("can you inspect the call logs")).toBeNull();
  });
});
