import { describe, expect, test } from "vitest";

import { detectTelegramControlIntent, normalizeTelegramControlIntentText } from "../src/core/telegram/control-intent.js";

describe("telegram control intent detection", () => {
  test("normalizes conversational control text for matching", () => {
    expect(normalizeTelegramControlIntentText("  Reconnect the bridge, please.  ")).toBe("reconnect the bridge please");
  });

  test("detects conversational reconnect requests", () => {
    expect(detectTelegramControlIntent("please restart the Telegram bridge")).toBe("reconnect");
    expect(detectTelegramControlIntent("can you reconnect the bot on your own")).toBe("reconnect");
    expect(detectTelegramControlIntent("are you able to restart the reconnecting on your own")).toBe("reconnect");
    expect(detectTelegramControlIntent("rebind the session now")).toBe("reconnect");
  });

  test("avoids false positives for general debugging chat", () => {
    expect(detectTelegramControlIntent("the websocket reconnect failed again")).toBeNull();
    expect(detectTelegramControlIntent("can you inspect the restart logs")).toBeNull();
    expect(detectTelegramControlIntent("I restarted my laptop earlier")).toBeNull();
  });
});
