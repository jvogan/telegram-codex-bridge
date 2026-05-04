import { describe, expect, test } from "vitest";

import type { BridgeConfig } from "../src/core/config.js";
import { buildCallInviteText, buildCallLaunchMarkup, buildCallLaunchUrl } from "../src/core/realtime/invite.js";
import type { RealtimeCallSurfaceRecord } from "../src/core/types.js";
import { createTestBridgeConfig } from "./helpers/test-config.js";

function createConfig(): BridgeConfig {
  return createTestBridgeConfig("/tmp", {
    realtime: {
      public_url: "https://example.trycloudflare.com/",
      control_url: "ws://127.0.0.1:8890/ws/bridge",
    },
  });
}

describe("realtime invite helpers", () => {
  test("builds a telegram mini app launch URL and markup", () => {
    const config = createConfig();
    const surface: RealtimeCallSurfaceRecord = {
      armed: true,
      armedAt: Date.now(),
      armedBy: "test",
      expiresAt: Date.now() + 60_000,
      lastActivityAt: Date.now(),
      lastPublicProbeAt: null,
      lastPublicProbeReady: null,
      lastPublicProbeDetail: null,
      lastPublicUrl: null,
      lastHealthUrl: null,
      lastLaunchUrl: null,
      lastDisarmReason: null,
      launchTokenId: "launch-token",
      launchTokenBridgeId: "bridge",
      launchTokenTelegramUserId: "123",
      launchTokenTelegramChatInstance: null,
      launchTokenReservedAt: null,
      launchTokenExpiresAt: Date.now() + 60_000,
      tunnelMode: "static-public-url",
      tunnelPid: null,
      tunnelUrl: null,
      tunnelStartedAt: null,
    };

    expect(buildCallLaunchUrl(config, surface)).toBe("https://example.trycloudflare.com/miniapp?bridgeId=bridge&launch=launch-token");
    expect(buildCallLaunchMarkup(config, surface)).toEqual({
      inline_keyboard: [[{
        text: "Open live call",
        web_app: {
          url: "https://example.trycloudflare.com/miniapp?bridgeId=bridge&launch=launch-token",
        },
      }]],
    });
  });

  test("formats invite text with an optional note", () => {
    const config = createConfig();
    expect(buildCallInviteText(config)).toContain("Open the Mini App to start Bridge Call.");
    expect(buildCallInviteText(config, "Bridge is ready to talk live.")).toContain("Bridge is ready to talk live.");
  });
});
