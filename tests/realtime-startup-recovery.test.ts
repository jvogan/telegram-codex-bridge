import { describe, expect, test } from "vitest";

import { planStartupCallSurfaceAction } from "../src/core/realtime/startup-recovery.js";
import type { ActiveCallRecord, RealtimeCallSurfaceRecord } from "../src/core/types.js";

function createSurface(overrides: Partial<RealtimeCallSurfaceRecord> = {}): RealtimeCallSurfaceRecord {
  const now = Date.now();
  return {
    armed: false,
    armedAt: null,
    armedBy: null,
    expiresAt: null,
    lastActivityAt: null,
    lastPublicProbeAt: null,
    lastPublicProbeReady: null,
    lastPublicProbeDetail: null,
    lastPublicUrl: null,
    lastHealthUrl: null,
    lastLaunchUrl: null,
    lastDisarmReason: null,
    launchTokenId: null,
    launchTokenBridgeId: null,
    launchTokenTelegramUserId: null,
    launchTokenTelegramChatInstance: null,
    launchTokenReservedAt: null,
    launchTokenExpiresAt: null,
    tunnelMode: "managed-quick-cloudflared",
    tunnelPid: null,
    tunnelUrl: null,
    tunnelStartedAt: now,
    ...overrides,
  };
}

describe("planStartupCallSurfaceAction", () => {
  test("recovers armed managed surfaces on startup", () => {
    expect(planStartupCallSurfaceAction({
      activeCall: null,
      surface: createSurface({
        armed: true,
        armedAt: 1_000,
        armedBy: "test",
        expiresAt: 2_000,
      }),
      tunnelPresent: true,
    })).toBe("recover_managed_surface");
  });

  test("preserves a live call that still needs finalization", () => {
    const activeCall: ActiveCallRecord = {
      callId: "call-1",
      bridgeId: "bridge",
      status: "finalizing",
      startedAt: 1_000,
      updatedAt: 2_000,
      endedAt: 3_000,
      endedReason: "user_hangup",
      transcriptPath: "/tmp/transcript.md",
      statePath: "/tmp/state.json",
      handoffJsonPath: "/tmp/handoff.json",
      handoffMarkdownPath: "/tmp/handoff.md",
      boundThreadId: "thread-1",
      cwd: "/repo",
      gatewayCallId: "gateway-call-1",
      telegramUserId: "123",
      telegramChatInstance: null,
      contextPack: null,
      eventPath: "/tmp/events.jsonl",
      artifactAppendedAt: null,
      recapMessageId: null,
    };

    expect(planStartupCallSurfaceAction({
      activeCall,
      surface: createSurface({
        armed: true,
        armedAt: 1_000,
        armedBy: "test",
        expiresAt: 2_000,
      }),
      tunnelPresent: true,
    })).toBe("preserve_for_finalization");
  });

  test("cleans up orphaned managed tunnels when the surface is not armed", () => {
    expect(planStartupCallSurfaceAction({
      activeCall: null,
      surface: createSurface(),
      tunnelPresent: true,
    })).toBe("cleanup_orphaned_tunnel");
  });
});
