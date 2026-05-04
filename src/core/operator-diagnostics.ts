import { existsSync } from "node:fs";
import { relative } from "node:path";

import { callNeedsFinalization, isCallLive } from "./realtime/finalization.js";
import type {
  ActiveCallRecord,
  ActiveTaskRecord,
  BoundThread,
  BridgeOwner,
  RecentCallSummary,
  RecentFailedTaskRecord,
  RealtimeCallSurfaceRecord,
} from "./types.js";

function isUnverifiedDesktopTurnId(turnId?: string | null): boolean {
  return turnId === "(unverified)"
    || turnId === "(unknown turn)"
    || (typeof turnId === "string" && turnId.length > 0 && !isVerifiedDesktopTurnId(turnId));
}

function isVerifiedDesktopTurnId(turnId?: string | null): turnId is string {
  return typeof turnId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(turnId);
}

export function formatTimestamp(timestamp: number | null): string {
  return timestamp ? new Date(timestamp).toISOString() : "none";
}

export function formatAgeSeconds(startedAt: number | null, now = Date.now()): string {
  if (!startedAt) {
    return "none";
  }
  return `${Math.max(0, Math.ceil((now - startedAt) / 1000))}s`;
}

export function describeLiveCallPriorityHint(input: {
  activeTask: ActiveTaskRecord | null;
  queuedTasks: number;
  pendingCallHandoffs: number;
}): string | null {
  if (input.activeTask) {
    return "/call can interrupt the in-flight Telegram task if you need live calling now.";
  }
  if (input.queuedTasks > 0) {
    return "/call can jump ahead of queued Telegram work.";
  }
  if (input.pendingCallHandoffs > 0) {
    return "/call can jump ahead of the pending handoff append.";
  }
  return null;
}

function compactTelemetryDetail(detail: string): string {
  const singleLine = detail.replace(/\s+/g, " ").trim();
  return singleLine.length > 180 ? `${singleLine.slice(0, 177)}...` : singleLine;
}

export function summarizeRecentCallSurfaceEvents(
  surface: RealtimeCallSurfaceRecord,
  now = Date.now(),
  limit = 3,
): string[] {
  return [...(surface.recentEvents ?? [])]
    .slice(-limit)
    .reverse()
    .map(event => `${event.action} ${event.outcome}${event.source ? ` via ${event.source}` : ""} (${formatAgeSeconds(event.at, now)} ago): ${compactTelemetryDetail(event.detail)}`);
}

export function describeCallStartBlocker(input: {
  activeTask: ActiveTaskRecord | null;
  activeCall: ActiveCallRecord | null;
  queuedTasks: number;
  pendingApprovals: number;
  pendingCallHandoffs: number;
  owner: BridgeOwner;
  binding: BoundThread | null;
  desktopTurnId?: string | null;
  explicitLiveCall?: boolean;
  now?: number;
}): string {
  const now = input.now ?? Date.now();
  if (input.activeTask) {
    return input.explicitLiveCall
      ? `active Telegram task ${input.activeTask.queueId} (${input.activeTask.stage}, ${formatAgeSeconds(input.activeTask.startedAt, now)}) will be interrupted by explicit /call`
      : `active Telegram task ${input.activeTask.queueId} (${input.activeTask.stage}, ${formatAgeSeconds(input.activeTask.startedAt, now)})`;
  }
  if (callNeedsFinalization(input.activeCall)) {
    if (isCallLive(input.activeCall)) {
      return `live call ${input.activeCall.callId} is already ${input.activeCall.status}`;
    }
    return `call ${input.activeCall.callId} is still finalizing`;
  }
  if (input.queuedTasks > 0) {
    return input.explicitLiveCall
      ? `${input.queuedTasks} queued Telegram task${input.queuedTasks === 1 ? "" : "s"} waiting; explicit /call will bypass the queue`
      : `${input.queuedTasks} queued Telegram task${input.queuedTasks === 1 ? "" : "s"} waiting`;
  }
  if (input.pendingApprovals > 0) {
    return `${input.pendingApprovals} pending approval${input.pendingApprovals === 1 ? "" : "s"}`;
  }
  if (input.pendingCallHandoffs > 0) {
    return input.explicitLiveCall
      ? `${input.pendingCallHandoffs} pending call handoff${input.pendingCallHandoffs === 1 ? "" : "s"} waiting; explicit /call will bypass the append backlog`
      : `${input.pendingCallHandoffs} pending call handoff${input.pendingCallHandoffs === 1 ? "" : "s"}`;
  }
  if (input.owner !== "telegram") {
    return `session owner is ${input.owner}`;
  }
  if (!input.binding) {
    return "no desktop thread is bound";
  }
  if (input.desktopTurnId) {
    if (isUnverifiedDesktopTurnId(input.desktopTurnId)) {
      return "desktop Codex turn activity could not be verified safely";
    }
    return input.explicitLiveCall
      ? `desktop Codex turn ${input.desktopTurnId} is active; explicit /call will interrupt it`
      : `desktop Codex turn ${input.desktopTurnId} is already active`;
  }
  return "none";
}

export interface CallStartResolution {
  blocked: boolean;
  summary: string;
  nextStep: string;
}

export function describeCallStartNextStep(input: {
  activeTask: ActiveTaskRecord | null;
  activeCall: ActiveCallRecord | null;
  queuedTasks: number;
  pendingApprovals: number;
  pendingCallHandoffs: number;
  owner: BridgeOwner;
  binding: BoundThread | null;
  desktopTurnId?: string | null;
  explicitLiveCall?: boolean;
}): string {
  if (input.activeTask) {
    return input.explicitLiveCall
      ? "Send /call now; the bridge will interrupt the in-flight Telegram task and switch into live calling."
      : "Wait for the in-flight Telegram task to finish, then retry /call.";
  }
  if (callNeedsFinalization(input.activeCall)) {
    return isCallLive(input.activeCall)
      ? "Wait for the active live call to finish, then retry /call."
      : "Wait for the prior live call to finish finalizing, then retry /call.";
  }
  if (input.queuedTasks > 0) {
    return input.explicitLiveCall
      ? "Send /call now; the bridge will skip the queue and prioritize the live call."
      : "Wait for queued Telegram tasks to drain, then retry /call.";
  }
  if (input.pendingApprovals > 0) {
    return "Resolve pending approvals, then retry /call.";
  }
  if (input.pendingCallHandoffs > 0) {
    return input.explicitLiveCall
      ? "Send /call now; the bridge will pause the pending handoff append and prioritize the live call."
      : "Let the pending call handoff append into Codex, then retry /call.";
  }
  if (input.owner !== "telegram") {
    return "Make Telegram the session owner, then retry /call.";
  }
  if (!input.binding) {
    return "Attach a desktop Codex thread, then retry /call.";
  }
  if (input.desktopTurnId) {
    if (isUnverifiedDesktopTurnId(input.desktopTurnId)) {
      return "Wait for the current desktop turn to settle or repair rollout visibility, then retry /call.";
    }
    return input.explicitLiveCall
      ? "Send /call now; the bridge will interrupt the current desktop turn and switch into live calling."
      : "Wait for the current desktop turn to finish, then retry /call.";
  }
  return "none";
}

export function resolveCallStartResolution(input: {
  activeTask: ActiveTaskRecord | null;
  activeCall: ActiveCallRecord | null;
  queuedTasks: number;
  pendingApprovals: number;
  pendingCallHandoffs: number;
  owner: BridgeOwner;
  binding: BoundThread | null;
  desktopTurnId?: string | null;
  explicitLiveCall?: boolean;
  interactiveBlocker?: {
    summary: string;
    nextStep: string;
  } | null;
  now?: number;
}): CallStartResolution {
  const summary = describeCallStartBlocker(input);
  if (summary !== "none") {
    const verifiedDesktopTurnActive = isVerifiedDesktopTurnId(input.desktopTurnId);
    const softExplicitBlocker = input.explicitLiveCall && (
      Boolean(input.activeTask)
      || (
        !input.activeTask
        && !callNeedsFinalization(input.activeCall)
        && input.queuedTasks > 0
      )
      || (
        !input.activeTask
        && !callNeedsFinalization(input.activeCall)
        && input.queuedTasks === 0
        && input.pendingApprovals === 0
        && input.pendingCallHandoffs > 0
        && input.owner === "telegram"
        && Boolean(input.binding)
      )
      || (
        !input.activeTask
        && !callNeedsFinalization(input.activeCall)
        && input.queuedTasks === 0
        && input.pendingApprovals === 0
        && input.pendingCallHandoffs === 0
        && input.owner === "telegram"
        && Boolean(input.binding)
        && verifiedDesktopTurnActive
      )
    );
    return {
      blocked: !softExplicitBlocker,
      summary,
      nextStep: describeCallStartNextStep(input),
    };
  }
  if (input.interactiveBlocker) {
    return {
      blocked: true,
      summary: input.interactiveBlocker.summary,
      nextStep: input.interactiveBlocker.nextStep,
    };
  }
  return {
    blocked: false,
    summary: "none",
    nextStep: "none",
  };
}

export function summarizeRecentFailedTask(
  failedTask: RecentFailedTaskRecord | null,
  now = Date.now(),
): {
  label: string;
  error: string;
  updatedAt: string;
} {
  if (!failedTask) {
    return {
      label: "none",
      error: "none",
      updatedAt: "none",
    };
  }
  return {
    label: `${failedTask.task.id}:${failedTask.task.kind} (${formatAgeSeconds(failedTask.updatedAt, now)} ago)`,
    error: failedTask.errorText ?? "unknown",
    updatedAt: formatTimestamp(failedTask.updatedAt),
  };
}

export function summarizeRecentCall(
  recentCall: RecentCallSummary | null,
  repoRoot: string,
): {
  label: string;
  endedAt: string;
  transcript: string;
  handoff: string;
  bundle: string;
  appendStatus: string;
} {
  if (!recentCall) {
    return {
      label: "none",
      endedAt: "none",
      transcript: "none",
      handoff: "none",
      bundle: "none",
      appendStatus: "none",
    };
  }
  const transcriptExists = existsSync(recentCall.transcriptPath);
  const handoffExists = existsSync(recentCall.handoffMarkdownPath);
  const bundleExists = existsSync(recentCall.bundlePath);
  if (!transcriptExists && !handoffExists && !bundleExists) {
    return {
      label: "none",
      endedAt: "none",
      transcript: "none",
      handoff: "none",
      bundle: "none",
      appendStatus: "none",
    };
  }
  const bundle = relative(repoRoot, recentCall.bundlePath) || ".";
  let appendStatus = "captured";
  if (!recentCall.hasUsableContent) {
    appendStatus = "no_usable_content";
  } else if (recentCall.handoffQueued) {
    appendStatus = "queued_for_append";
  } else if (recentCall.artifactAppendedAt) {
    appendStatus = "appended_to_codex";
  }
  return {
    label: `${recentCall.callId}:${recentCall.endedReason}`,
    endedAt: formatTimestamp(recentCall.endedAt),
    transcript: transcriptExists ? relative(repoRoot, recentCall.transcriptPath) : "missing",
    handoff: handoffExists ? relative(repoRoot, recentCall.handoffMarkdownPath) : "missing",
    bundle,
    appendStatus,
  };
}
