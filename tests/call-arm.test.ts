import { describe, expect, test } from "vitest";

import { describeCallArmBlocker } from "../src/core/realtime/call-enable.js";
import type { ActiveCallRecord, BoundThread } from "../src/core/types.js";

const binding: BoundThread = {
  threadId: "thread-1",
  cwd: "/repo",
  rolloutPath: "/tmp/rollout.jsonl",
  source: "vscode",
  boundAt: 1_000,
};

describe("call arm blockers", () => {
  test("allows arming while the shared session may still be busy", () => {
    expect(describeCallArmBlocker({
      activeCall: null,
      owner: "telegram",
      binding,
      gatewayReady: true,
      gatewayConnected: true,
    })).toBeNull();
  });

  test("blocks arming when the gateway is unavailable", () => {
    expect(describeCallArmBlocker({
      activeCall: null,
      owner: "telegram",
      binding,
      gatewayReady: false,
      gatewayConnected: true,
    })).toEqual({
      code: "gateway_down",
      summary: "The realtime gateway is not healthy.",
      nextStep: "Repair or restart the gateway, then retry arming live calling.",
    });
  });

  test("blocks arming when ownership or binding is missing", () => {
    expect(describeCallArmBlocker({
      activeCall: null,
      owner: "desktop",
      binding,
    })?.code).toBe("owner_not_telegram");

    expect(describeCallArmBlocker({
      activeCall: null,
      owner: "telegram",
      binding: null,
    })?.code).toBe("unbound");
  });

  test("blocks arming while a live call is active", () => {
    const activeCall: ActiveCallRecord = {
      callId: "call-1",
      bridgeId: "bridge",
      status: "active",
      startedAt: 1_000,
      updatedAt: 1_500,
      endedAt: null,
      endedReason: null,
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

    expect(describeCallArmBlocker({
      activeCall,
      owner: "telegram",
      binding,
    })).toEqual({
      code: "call_active",
      summary: "A live call is already active (call-1).",
      nextStep: "Wait for the active call to clear, then retry arming live calling.",
    });
  });
});
