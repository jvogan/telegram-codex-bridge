import { describe, expect, test } from "vitest";

import {
  detectTelegramTerminalIntent,
  extractTelegramTerminalAskText,
  normalizeTelegramTerminalIntentText,
} from "../src/core/telegram/terminal-intent.js";

describe("Telegram terminal intent detection", () => {
  test("normalizes natural terminal lane requests", () => {
    expect(normalizeTelegramTerminalIntentText("Try again. Talk to the terminal CLI")).toBe("try again talk to the terminal cli");
  });

  test("detects natural terminal chat connection requests", () => {
    expect(detectTelegramTerminalIntent("Try again. Talk to the terminal CLI")).toBe("connect");
    expect(detectTelegramTerminalIntent("connect Telegram to the terminal lane")).toBe("connect");
    expect(detectTelegramTerminalIntent("use terminal cli for chat")).toBe("connect");
    expect(detectTelegramTerminalIntent("terminal chat on")).toBe("connect");
    expect(detectTelegramTerminalIntent("Still connected? Let's keep working with the terminal")).toBe("connect");
    expect(detectTelegramTerminalIntent("continue working with the terminal lane")).toBe("connect");
  });

  test("detects natural terminal disconnect requests", () => {
    expect(detectTelegramTerminalIntent("switch back to the desktop")).toBe("disconnect");
    expect(detectTelegramTerminalIntent("terminal chat off")).toBe("disconnect");
  });

  test("detects natural pings for the terminal Codex lane", () => {
    expect(detectTelegramTerminalIntent("test the terminal codex lane")).toBe("ping");
    expect(detectTelegramTerminalIntent("can you poke codex terminal?")).toBe("ping");
  });

  test("extracts one-off natural terminal ask prompts", () => {
    expect(detectTelegramTerminalIntent("Ask the terminal lane to list top-level files")).toBe("ask");
    expect(extractTelegramTerminalAskText("Ask the terminal lane to list top-level files")).toBe("list top-level files");
    expect(detectTelegramTerminalIntent("terminal lane: list top-level files")).toBe("ask");
    expect(extractTelegramTerminalAskText("terminal lane: list top-level files")).toBe("list top-level files");
    expect(detectTelegramTerminalIntent("use terminal cli to summarize Downloads/report.pdf")).toBe("ask");
    expect(extractTelegramTerminalAskText("send this to the terminal lane: say hello")).toBe("say hello");
  });

  test("avoids broad terminal mentions without a terminal Codex target", () => {
    expect(detectTelegramTerminalIntent("run npm test in terminal")).toBeNull();
    expect(detectTelegramTerminalIntent("the cli failed again")).toBeNull();
    expect(detectTelegramTerminalIntent(
      "Make a clean diagram image of the bridge with a side tmux terminal lane. Send the image back.",
    )).toBeNull();
  });
});
