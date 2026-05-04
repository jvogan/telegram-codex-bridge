import type { ActiveCallRecord, BoundThread, BridgeOwner } from "../types.js";

import { callNeedsFinalization, isCallLive } from "./finalization.js";

export type CallStartBlockerCode =
  | "realtime_disabled"
  | "gateway_down"
  | "gateway_disconnected"
  | "disarmed"
  | "public_surface_down"
  | "call_active"
  | "task_in_flight"
  | "codex_busy"
  | "queue_backlog"
  | "pending_approvals"
  | "pending_handoff"
  | "owner_not_telegram"
  | "unbound";

export interface CallStartBlocker {
  code: CallStartBlockerCode;
  summary: string;
  nextStep: string;
}

export function shouldOfferCallEnableRequest(blocker: Pick<CallStartBlocker, "code">): boolean {
  return blocker.code === "disarmed";
}

export function shouldPreemptBlockerForExplicitLiveCall(blocker: Pick<CallStartBlocker, "code">): boolean {
  return blocker.code === "task_in_flight" || blocker.code === "codex_busy";
}

export function shouldIgnoreBlockerForExplicitLiveCall(blocker: Pick<CallStartBlocker, "code">): boolean {
  return blocker.code === "queue_backlog" || blocker.code === "pending_handoff";
}

export function shouldSuppressExplicitLiveCallBlocker(blocker: Pick<CallStartBlocker, "code">): boolean {
  return shouldPreemptBlockerForExplicitLiveCall(blocker) || shouldIgnoreBlockerForExplicitLiveCall(blocker);
}

export function shouldBlockPendingCallHandoffForLiveCall(input: {
  pendingCallHandoffs: number;
  explicitLiveCall?: boolean | undefined;
}): boolean {
  return input.pendingCallHandoffs > 0 && !input.explicitLiveCall;
}

function isVerifiedDesktopTurnId(turnId?: string | null): boolean {
  return typeof turnId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(turnId);
}

export function shouldAllowSnapshotBootstrapForExplicitLiveCall(input: {
  blocker: Pick<CallStartBlocker, "code">;
  activeTaskPresent?: boolean;
  localTurnActive?: boolean;
  desktopTurnId?: string | null;
}): boolean {
  if (shouldIgnoreBlockerForExplicitLiveCall(input.blocker)) {
    return true;
  }
  if (input.blocker.code === "task_in_flight") {
    return Boolean(input.activeTaskPresent);
  }
  if (input.blocker.code !== "codex_busy") {
    return false;
  }
  if (isVerifiedDesktopTurnId(input.desktopTurnId)) {
    return true;
  }
  return Boolean(input.localTurnActive);
}

export function buildCallEnableOfferLine(): string {
  return "If you want, send `/call enable` and I'll arm live calling for this bridge.";
}

export function describeCallArmBlocker(input: {
  activeCall: ActiveCallRecord | null | undefined;
  owner: BridgeOwner;
  binding: BoundThread | null;
  gatewayReady?: boolean | undefined;
  gatewayConnected?: boolean | undefined;
}): CallStartBlocker | null {
  if (callNeedsFinalization(input.activeCall)) {
    return {
      code: "call_active",
      summary: isCallLive(input.activeCall)
        ? `A live call is already active (${input.activeCall?.callId ?? "(unknown call)"}).`
        : `A previous live call is still being finalized (${input.activeCall?.callId ?? "(unknown call)"}).`,
      nextStep: "Wait for the active call to clear, then retry arming live calling.",
    };
  }
  if (input.owner !== "telegram") {
    return {
      code: "owner_not_telegram",
      summary: `The session owner is ${input.owner}, not telegram.`,
      nextStep: "Switch ownership back to telegram, then retry arming live calling.",
    };
  }
  if (!input.binding) {
    return {
      code: "unbound",
      summary: "No desktop Codex thread is attached.",
      nextStep: "Attach a desktop Codex thread, then retry arming live calling.",
    };
  }
  if (input.gatewayReady === false) {
    return {
      code: "gateway_down",
      summary: "The realtime gateway is not healthy.",
      nextStep: "Repair or restart the gateway, then retry arming live calling.",
    };
  }
  if (input.gatewayConnected === false) {
    return {
      code: "gateway_disconnected",
      summary: "The realtime gateway control channel is not connected.",
      nextStep: "Reconnect the gateway control channel, then retry arming live calling.",
    };
  }
  return null;
}
