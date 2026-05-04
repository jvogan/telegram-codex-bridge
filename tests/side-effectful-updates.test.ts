import { describe, expect, test } from "vitest";

import { sideEffectfulSlashCommandCategory } from "../src/core/telegram/side-effectful-updates.js";

describe("side-effectful Telegram slash commands", () => {
  test("claims call starts but not call status checks", () => {
    expect(sideEffectfulSlashCommandCategory("/call", [])).toBe("command:/call");
    expect(sideEffectfulSlashCommandCategory("/call", ["status"])).toBeNull();
  });

  test("normalizes bot mentions before classifying commands", () => {
    expect(sideEffectfulSlashCommandCategory("/PROVIDER@ExampleBridgeBot", ["image", "openai"])).toBe("command:/provider");
  });

  test("does not classify private-only or read-only commands as side-effectful", () => {
    expect(sideEffectfulSlashCommandCategory("/terminal", ["status"])).toBeNull();
    expect(sideEffectfulSlashCommandCategory("/help", [])).toBeNull();
  });

  test("claims terminal commands that change routing or send work", () => {
    expect(sideEffectfulSlashCommandCategory("/terminal", ["start"])).toBe("command:/terminal");
    expect(sideEffectfulSlashCommandCategory("/terminal", ["ask", "list"])).toBe("command:/terminal");
    expect(sideEffectfulSlashCommandCategory("/terminal", ["chat", "on"])).toBe("command:/terminal");
  });

  test("claims verified desktop thread switching commands", () => {
    expect(sideEffectfulSlashCommandCategory("/teleport", ["current"])).toBe("command:/teleport");
    expect(sideEffectfulSlashCommandCategory("/teleport@ExampleBridgeBot", ["back"])).toBe("command:/teleport");
  });
});
