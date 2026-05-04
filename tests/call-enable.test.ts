import { describe, expect, test } from "vitest";

import {
  buildCallEnableOfferLine,
  shouldAllowSnapshotBootstrapForExplicitLiveCall,
  shouldBlockPendingCallHandoffForLiveCall,
  shouldIgnoreBlockerForExplicitLiveCall,
  shouldPreemptBlockerForExplicitLiveCall,
  shouldOfferCallEnableRequest,
  shouldSuppressExplicitLiveCallBlocker,
  type CallStartBlocker,
} from "../src/core/realtime/call-enable.js";

describe("call enable helpers", () => {
  test("offers the shortcut only when live calling is disarmed", () => {
    const disarmed: CallStartBlocker = {
      code: "disarmed",
      summary: "Live calling is disarmed.",
      nextStep: "Run `bridgectl call arm`.",
    };
    const gatewayDown: CallStartBlocker = {
      code: "gateway_down",
      summary: "The realtime gateway is not healthy.",
      nextStep: "Repair the gateway.",
    };

    expect(shouldOfferCallEnableRequest(disarmed)).toBe(true);
    expect(shouldOfferCallEnableRequest(gatewayDown)).toBe(false);
  });

  test("builds a Telegram-facing offer line", () => {
    expect(buildCallEnableOfferLine()).toContain("/call enable");
    expect(buildCallEnableOfferLine()).toContain("arm live calling");
    expect(buildCallEnableOfferLine()).not.toContain("ask the bound Codex session");
  });

  test("marks explicit live-call blockers that should preempt the current turn", () => {
    expect(shouldPreemptBlockerForExplicitLiveCall({ code: "task_in_flight" })).toBe(true);
    expect(shouldPreemptBlockerForExplicitLiveCall({ code: "codex_busy" })).toBe(true);
    expect(shouldPreemptBlockerForExplicitLiveCall({ code: "queue_backlog" })).toBe(false);
  });

  test("lets explicit live calls bypass queued backlog", () => {
    expect(shouldIgnoreBlockerForExplicitLiveCall({ code: "queue_backlog" })).toBe(true);
    expect(shouldIgnoreBlockerForExplicitLiveCall({ code: "pending_handoff" })).toBe(true);
    expect(shouldIgnoreBlockerForExplicitLiveCall({ code: "pending_approvals" })).toBe(false);
  });

  test("blocks pending handoff backlog only for non-explicit live-call starts", () => {
    expect(shouldBlockPendingCallHandoffForLiveCall({
      pendingCallHandoffs: 1,
      explicitLiveCall: false,
    })).toBe(true);
    expect(shouldBlockPendingCallHandoffForLiveCall({
      pendingCallHandoffs: 1,
      explicitLiveCall: true,
    })).toBe(false);
    expect(shouldBlockPendingCallHandoffForLiveCall({
      pendingCallHandoffs: 0,
      explicitLiveCall: false,
    })).toBe(false);
  });

  test("suppresses only soft explicit live-call blockers", () => {
    expect(shouldSuppressExplicitLiveCallBlocker({ code: "task_in_flight" })).toBe(true);
    expect(shouldSuppressExplicitLiveCallBlocker({ code: "queue_backlog" })).toBe(true);
    expect(shouldSuppressExplicitLiveCallBlocker({ code: "pending_handoff" })).toBe(true);
    expect(shouldSuppressExplicitLiveCallBlocker({ code: "disarmed" })).toBe(false);
  });

  test("lets snapshot bootstrap continue while an interrupted Telegram task is still draining", () => {
    expect(shouldAllowSnapshotBootstrapForExplicitLiveCall({
      blocker: { code: "task_in_flight" },
      activeTaskPresent: true,
      localTurnActive: true,
    })).toBe(true);
  });

  test("lets snapshot bootstrap continue while a verified desktop turn is still yielding", () => {
    expect(shouldAllowSnapshotBootstrapForExplicitLiveCall({
      blocker: { code: "codex_busy" },
      localTurnActive: false,
      desktopTurnId: "019d7d4a-e809-7d10-be21-b539b4216943",
    })).toBe(true);
  });

  test("fails closed for unverified busy state during snapshot bootstrap", () => {
    expect(shouldAllowSnapshotBootstrapForExplicitLiveCall({
      blocker: { code: "codex_busy" },
      localTurnActive: false,
      desktopTurnId: "(unverified)",
    })).toBe(false);
    expect(shouldAllowSnapshotBootstrapForExplicitLiveCall({
      blocker: { code: "codex_busy" },
      localTurnActive: false,
      desktopTurnId: "turn-42",
    })).toBe(false);
  });
});
