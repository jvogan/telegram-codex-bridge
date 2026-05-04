import { describe, expect, test } from "vitest";

import { redactLogFields, redactUrlForLogs, maskIdentifier, maskIpAddress } from "../src/core/redaction.js";

describe("redaction", () => {
  test("masks sensitive log fields by key", () => {
    const fields = redactLogFields({
      chatId: "123456789",
      username: "bridge_user",
      firstName: "Avery",
      prompt: "draw a private roadmap",
      clientIp: "203.0.113.42",
      launchUrl: "https://example.com/miniapp?bridgeId=bridge&launch=launch-token",
      url: "/miniapp?bridgeId=bridge&launch=launch-token",
      message: "Failed to process /image sunset skyline for bridge bridge-1",
      error: "Webhook probe failed at /miniapp?bridgeId=bridge&launch=launch-token",
      nested: {
        telegramUserId: "99887766",
        text: "private message body",
      },
    });

    expect(fields).toEqual({
      chatId: "12...89 (9 chars)",
      username: "[redacted]",
      firstName: "[redacted]",
      prompt: expect.stringContaining("[redacted text chars="),
      clientIp: "203.0.113.x",
      launchUrl: "https://example.com/miniapp?bridgeId=bridge&launch=%5Bredacted%5D",
      url: "/miniapp?bridgeId=bridge&launch=%5Bredacted%5D",
      message: expect.stringContaining("[redacted text chars="),
      error: "Webhook probe failed at /miniapp?bridgeId=bridge&launch=[redacted]",
      nested: {
        telegramUserId: "99...66 (8 chars)",
        text: expect.stringContaining("[redacted text chars="),
      },
    });
  });

  test("keeps safe status helpers deterministic", () => {
    expect(maskIdentifier("123")).toBe("*** (3 chars)");
    expect(maskIdentifier("123456789")).toBe("12...89 (9 chars)");
    expect(maskIpAddress("2001:db8::1")).toBe("2001:db8::[redacted]");
    expect(redactUrlForLogs("https://example.com/miniapp?launch=secret&bridgeId=bridge"))
      .toBe("https://example.com/miniapp?launch=%5Bredacted%5D&bridgeId=bridge");
    expect(redactUrlForLogs("/miniapp?launch=secret&bridgeId=bridge"))
      .toBe("/miniapp?launch=%5Bredacted%5D&bridgeId=bridge");
    expect(redactLogFields({ info: "monkey=banana" })).toEqual({ info: "monkey=banana" });
  });
});
