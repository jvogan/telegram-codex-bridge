import { describe, expect, test } from "vitest";

import {
  normalizeTelegramSlashCommandName,
  parseTelegramSlashCommand,
} from "../src/core/telegram/slash-command.js";

describe("Telegram slash command parsing", () => {
  test("parses commands with arguments", () => {
    expect(parseTelegramSlashCommand("/call status")).toEqual({
      command: "/call",
      args: ["status"],
    });
  });

  test("normalizes bot mentions from group commands", () => {
    expect(parseTelegramSlashCommand("  /CALL@ExampleBridgeBot now")).toEqual({
      command: "/call",
      args: ["now"],
    });
    expect(normalizeTelegramSlashCommandName("/provider@ExampleBridgeBot")).toBe("/provider");
  });

  test("rejects non-command text and bare slash", () => {
    expect(parseTelegramSlashCommand("please call me")).toBeNull();
    expect(parseTelegramSlashCommand("/")).toBeNull();
  });
});
