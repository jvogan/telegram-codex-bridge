import { describe, expect, test } from "vitest";

import {
  cleanupStaleLaunchTokenReservation,
  describeLaunchTokenState,
  describeRememberedDisarmedCallSurface,
  hasOutstandingLaunchToken,
  isLaunchTokenValid,
  recordCallSurfaceDisarmReason,
  recordPublicSurfaceProbe,
  releaseLaunchTokenReservation,
  reserveLaunchTokenChatInstance,
  shouldFailClosedArmingSurface,
} from "../src/core/realtime/surface.js";
import type { RealtimeCallSurfaceRecord } from "../src/core/types.js";

function createSurface(overrides: Partial<RealtimeCallSurfaceRecord> = {}): RealtimeCallSurfaceRecord {
  return {
    armed: true,
    armedAt: 1_000,
    armedBy: "test",
    expiresAt: 301_000,
    lastActivityAt: 1_000,
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
    launchTokenTelegramChatInstance: "chat-instance",
    launchTokenReservedAt: null,
    launchTokenExpiresAt: 601_000,
    tunnelMode: "managed-quick-cloudflared",
    tunnelPid: 123,
    tunnelUrl: "https://example.trycloudflare.com",
    tunnelStartedAt: 5_000,
    ...overrides,
  };
}

describe("shouldFailClosedArmingSurface", () => {
  test("uses tunnel start time when deciding whether to abandon arming", () => {
    const surface = createSurface({
      armedAt: 1_000,
      tunnelStartedAt: 20_000,
    });

    expect(shouldFailClosedArmingSurface(surface, 79_000, 60_000)).toBe(false);
    expect(shouldFailClosedArmingSurface(surface, 80_000, 60_000)).toBe(true);
  });

  test("does not fail closed once the launch token is gone", () => {
    const surface = createSurface({
      launchTokenId: null,
      launchTokenBridgeId: null,
      launchTokenTelegramUserId: null,
      launchTokenTelegramChatInstance: null,
      launchTokenReservedAt: null,
      launchTokenExpiresAt: null,
    });

    expect(shouldFailClosedArmingSurface(surface, 120_000, 60_000)).toBe(false);
  });

  test("binds launch tokens to the intended bridge and Telegram user", () => {
    const surface = createSurface();

    expect(isLaunchTokenValid(surface, "launch-token", {
      now: 10_000,
      bridgeId: "bridge",
      telegramUserId: "123",
      telegramChatInstance: "chat-instance",
    })).toBe(true);
    expect(isLaunchTokenValid(surface, "launch-token", {
      now: 10_000,
      bridgeId: "other-bridge",
      telegramUserId: "123",
      telegramChatInstance: "chat-instance",
    })).toBe(false);
    expect(isLaunchTokenValid(surface, "launch-token", {
      now: 10_000,
      bridgeId: "bridge",
      telegramUserId: "999",
      telegramChatInstance: "chat-instance",
    })).toBe(false);
    expect(isLaunchTokenValid(surface, "launch-token", {
      now: 10_000,
      bridgeId: "bridge",
      telegramUserId: "123",
      telegramChatInstance: "wrong-chat",
    })).toBe(false);
  });

  test("treats expired launch tokens as unavailable", () => {
    expect(hasOutstandingLaunchToken(createSurface({
      launchTokenExpiresAt: 999,
    }), 1_000)).toBe(false);
    expect(hasOutstandingLaunchToken(createSurface(), 10_000)).toBe(true);
  });

  test("remembers the last public-surface failure across disarm", () => {
    const surface = createSurface({ armed: true });
    const observed = recordPublicSurfaceProbe(surface, {
      ready: false,
      detail: "Mini App is unreachable (network timed out)",
      publicUrl: "https://example.trycloudflare.com",
      healthUrl: "https://example.trycloudflare.com/healthz",
      launchUrl: "https://example.trycloudflare.com/miniapp?bridgeId=bridge&launch=launch-token",
    }, 9_000);
    const disarmed = recordCallSurfaceDisarmReason({ ...observed, armed: false }, "interval:public_unreachable");

    expect(disarmed.lastPublicProbeAt).toBe(9_000);
    expect(describeRememberedDisarmedCallSurface(disarmed)).toBe(
      "call surface is disarmed (last failure: Mini App is unreachable (network timed out))",
    );
  });

  test("describes consumed, expired, and manually disarmed launch-token states", () => {
    expect(describeLaunchTokenState(createSurface({
      launchTokenId: null,
      launchTokenBridgeId: null,
      launchTokenTelegramUserId: null,
      launchTokenTelegramChatInstance: null,
      launchTokenReservedAt: null,
      launchTokenExpiresAt: null,
    }))).toBe("launch token was already consumed by a client; run `bridgectl call arm` to mint a fresh invite");

    expect(describeLaunchTokenState(createSurface({
      launchTokenExpiresAt: 1_000,
    }), 2_000)).toBe("launch token expired; run `bridgectl call arm` to mint a fresh invite");

    expect(describeLaunchTokenState(createSurface({
      launchTokenTelegramChatInstance: "chat-instance",
      launchTokenReservedAt: 10_000,
    }), 2_000)).toBe(
      "launch token is reserved for an in-progress Telegram Mini App session; if that launch is stuck, send `/call` again to mint a fresh invite",
    );

    expect(describeLaunchTokenState(recordCallSurfaceDisarmReason(createSurface({
      armed: false,
      launchTokenId: null,
      launchTokenBridgeId: null,
      launchTokenTelegramUserId: null,
      launchTokenTelegramChatInstance: null,
      launchTokenReservedAt: null,
      launchTokenExpiresAt: null,
    }), "bridgectl call disarm"))).toBe(
      "call surface was manually disarmed; run `bridgectl call arm` to mint a fresh invite",
    );
  });

  test("releases a launch-token reservation after a pre-start cancellation", () => {
    const surface = createSurface({
      launchTokenTelegramChatInstance: "chat-instance",
      launchTokenReservedAt: 10_000,
    });

    expect(releaseLaunchTokenReservation(surface, { token: "launch-token" })).toMatchObject({
      launchTokenId: "launch-token",
      launchTokenTelegramChatInstance: null,
      launchTokenReservedAt: null,
    });
    expect(releaseLaunchTokenReservation(surface, { token: "other-token" })).toBe(surface);
  });

  test("cleans stale launch-token reservations without consuming the invite", () => {
    const reserved = reserveLaunchTokenChatInstance(createSurface({
      launchTokenTelegramChatInstance: null,
      launchTokenReservedAt: null,
    }), "chat-instance", 20_000);

    expect(reserved).toMatchObject({
      launchTokenId: "launch-token",
      launchTokenTelegramChatInstance: "chat-instance",
      launchTokenReservedAt: 20_000,
    });
    expect(cleanupStaleLaunchTokenReservation(reserved, 139_999, 120_000)).toBe(reserved);
    expect(cleanupStaleLaunchTokenReservation(reserved, 140_000, 120_000)).toMatchObject({
      launchTokenId: "launch-token",
      launchTokenTelegramChatInstance: null,
      launchTokenReservedAt: null,
    });
  });
});
