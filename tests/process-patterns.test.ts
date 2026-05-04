import { describe, expect, test } from "vitest";

import {
  isManagedRealtimeGatewayProcess,
  isManagedTelegramDaemonProcess,
} from "../src/core/util/process-patterns.js";

describe("process pattern compatibility", () => {
  test("matches bridge telegram-daemon process titles", () => {
    expect(isManagedTelegramDaemonProcess("bridge-telegram-daemon")).toBe(true);
    expect(isManagedTelegramDaemonProcess("node /tmp/dist/bin/telegram-daemon.js")).toBe(true);
    expect(isManagedTelegramDaemonProcess("node /tmp/other-script.js")).toBe(false);
  });

  test("matches bridge realtime-gateway process titles", () => {
    expect(isManagedRealtimeGatewayProcess("bridge-realtime-gateway")).toBe(true);
    expect(isManagedRealtimeGatewayProcess("bun /tmp/dist/bin/realtime-gateway.js")).toBe(true);
    expect(isManagedRealtimeGatewayProcess("bun /tmp/dist/bin/telegram-daemon.js")).toBe(false);
  });

  test("does not match legacy private-brand process titles", () => {
    // Regression guard: legacy brand names were removed for privacy. They must
    // stay unmatched so a future refactor cannot silently reintroduce them.
    const legacyTelegram = ["hype", "rion"].join("") + "-telegram-daemon";
    const legacyGateway = ["hype", "rion"].join("") + "-realtime-gateway";
    expect(isManagedTelegramDaemonProcess(legacyTelegram)).toBe(false);
    expect(isManagedRealtimeGatewayProcess(legacyGateway)).toBe(false);
  });
});
