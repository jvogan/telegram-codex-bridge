import type { ActiveCallRecord } from "../types.js";

export function isCallLive(call: ActiveCallRecord | null | undefined): boolean {
  return Boolean(call && ["starting", "active"].includes(call.status));
}

export function callNeedsFinalization(call: ActiveCallRecord | null | undefined): call is ActiveCallRecord {
  if (!call) {
    return false;
  }
  if (call.status === "finalizing") {
    return true;
  }
  if (call.status === "starting" || call.status === "active") {
    return true;
  }
  if (call.status === "ended" || call.status === "interrupted") {
    return !call.artifactAppendedAt || !call.recapMessageId;
  }
  return false;
}

export function callBlocksAsyncWork(call: ActiveCallRecord | null | undefined): boolean {
  return callNeedsFinalization(call);
}

export function callHoldReason(call: ActiveCallRecord | null | undefined): "call_active" | "call_finalizing" | null {
  if (!callNeedsFinalization(call)) {
    return null;
  }
  return isCallLive(call) ? "call_active" : "call_finalizing";
}

export function shouldRecordRealtimeUsage(call: ActiveCallRecord | null | undefined): boolean {
  return !call?.endedAt;
}

export function activeCallStatusLabel(call: ActiveCallRecord | null | undefined): string | null {
  if (!call) {
    return null;
  }
  if (["starting", "active", "finalizing"].includes(call.status)) {
    return call.status;
  }
  return callNeedsFinalization(call) ? `recovering:${call.status}` : null;
}
