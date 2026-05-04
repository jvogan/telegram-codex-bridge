import { describe, expect, test } from "vitest";

import { activeCallStatusLabel, callBlocksAsyncWork, callHoldReason, callNeedsFinalization, isCallLive, shouldRecordRealtimeUsage } from "../src/core/realtime/finalization.js";
import type { ActiveCallRecord } from "../src/core/types.js";

function createCall(overrides: Partial<ActiveCallRecord>): ActiveCallRecord {
  return {
    callId: "call-1",
    bridgeId: "bridge",
    status: "starting",
    startedAt: 1_000,
    updatedAt: 1_000,
    endedAt: null,
    endedReason: null,
    boundThreadId: "thread-1",
    cwd: "/tmp/workspace",
    gatewayCallId: null,
    telegramUserId: "123",
    telegramChatInstance: null,
    contextPack: null,
    eventPath: "/tmp/events.ndjson",
    transcriptPath: "/tmp/transcript.md",
    statePath: "/tmp/state.json",
    handoffJsonPath: "/tmp/handoff.json",
    handoffMarkdownPath: "/tmp/handoff.md",
    artifactAppendedAt: null,
    recapMessageId: null,
    ...overrides,
  };
}

describe("realtime finalization helpers", () => {
  test("treats starting calls as live and blocking", () => {
    const call = createCall({ status: "starting" });

    expect(isCallLive(call)).toBe(true);
    expect(callNeedsFinalization(call)).toBe(true);
    expect(callBlocksAsyncWork(call)).toBe(true);
    expect(callHoldReason(call)).toBe("call_active");
    expect(activeCallStatusLabel(call)).toBe("starting");
    expect(shouldRecordRealtimeUsage(call)).toBe(true);
  });

  test("treats ended calls without recap or handoff as recoverable cleanup work", () => {
    const call = createCall({
      status: "ended",
      endedAt: 2_000,
      endedReason: "browser_disconnect",
    });

    expect(isCallLive(call)).toBe(false);
    expect(callNeedsFinalization(call)).toBe(true);
    expect(callBlocksAsyncWork(call)).toBe(true);
    expect(callHoldReason(call)).toBe("call_finalizing");
    expect(activeCallStatusLabel(call)).toBe("recovering:ended");
    expect(shouldRecordRealtimeUsage(call)).toBe(false);
  });

  test("treats fully finalized ended calls as inactive", () => {
    const call = createCall({
      status: "ended",
      endedAt: 2_000,
      endedReason: "browser_disconnect",
      artifactAppendedAt: 2_100,
      recapMessageId: 42,
    });

    expect(callNeedsFinalization(call)).toBe(false);
    expect(callBlocksAsyncWork(call)).toBe(false);
    expect(callHoldReason(call)).toBeNull();
    expect(activeCallStatusLabel(call)).toBeNull();
  });
});
