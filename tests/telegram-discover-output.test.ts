import { describe, expect, test } from "vitest";

import { formatDiscoveredPrivateChatLine, formatWebhookStatusLine } from "../src/core/telegram/discover-output.js";

describe("telegram discover output", () => {
  test("keeps default webhook output redacted", () => {
    expect(formatWebhookStatusLine("https://hooks.example.com/private/path?token=secret"))
      .toBe("Webhook configured: yes (url redacted)");
  });

  test("shows only origin in verbose webhook output", () => {
    expect(formatWebhookStatusLine("https://hooks.example.com/private/path?token=secret", { verbose: true }))
      .toBe("Webhook configured: https://hooks.example.com/[redacted]");
  });

  test("shows only the exact chat id by default", () => {
    expect(formatDiscoveredPrivateChatLine({
      chatId: "123456789",
      username: "bridge_user",
      firstName: "Avery",
      lastName: "Lane",
    })).toBe("- 123456789");
  });

  test("shows labels only in verbose mode", () => {
    expect(formatDiscoveredPrivateChatLine({
      chatId: "123456789",
      username: "bridge_user",
      firstName: "Avery",
      lastName: "Lane",
    }, { verbose: true })).toBe("- 123456789 @bridge_user");
    expect(formatDiscoveredPrivateChatLine({
      chatId: "123456789",
      firstName: "Avery",
      lastName: "Lane",
    }, { verbose: true })).toBe("- 123456789 Avery Lane");
  });
});
