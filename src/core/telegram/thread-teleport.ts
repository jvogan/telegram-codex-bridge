import type { BoundThread } from "../types.js";

export interface ThreadTeleportActivity {
  activeTurnId: string | null;
  lastStartedAt: number | null;
  lastCompletedAt: number | null;
  error?: string | null;
}

export interface ThreadTeleportStatus {
  mode: string;
  owner: string;
  queueCount: number;
  pendingApprovals: number;
  binding: BoundThread | null;
}

export function shortThreadId(threadId: string): string {
  return threadId.length > 12 ? `${threadId.slice(0, 12)}...` : threadId;
}

function timestampMs(value: number | undefined | null): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value < 10_000_000_000 ? value * 1000 : value;
}

function ageLabel(value: number | undefined | null, now = Date.now()): string {
  const ms = timestampMs(value);
  if (!ms) {
    return "unknown";
  }
  const ageSeconds = Math.max(0, Math.ceil((now - ms) / 1000));
  if (ageSeconds < 60) {
    return `${ageSeconds}s ago`;
  }
  const ageMinutes = Math.ceil(ageSeconds / 60);
  if (ageMinutes < 60) {
    return `${ageMinutes}m ago`;
  }
  const ageHours = Math.ceil(ageMinutes / 60);
  return `${ageHours}h ago`;
}

export function threadActivityLabel(activity: ThreadTeleportActivity | null): string {
  if (!activity || activity.error) {
    return "activity unknown";
  }
  if (activity.activeTurnId) {
    return `active ${shortThreadId(activity.activeTurnId)}`;
  }
  if (
    activity.lastStartedAt
    && (!activity.lastCompletedAt || activity.lastStartedAt > activity.lastCompletedAt)
  ) {
    return "active";
  }
  return "idle";
}

export function renderThreadTeleportList(input: {
  threads: BoundThread[];
  boundThreadId?: string | null;
  cwdLabel?: string | null;
  activities?: Map<string, ThreadTeleportActivity | null>;
  formatPath?: (path: string) => string;
  now?: number;
}): string {
  const title = input.cwdLabel
    ? `Recent desktop threads for ${input.cwdLabel}`
    : "Recent desktop threads";
  const lines = [
    title,
    "Use /teleport <thread_id> to move Telegram to one of these sessions.",
    "",
  ];
  const formatPath = input.formatPath ?? ((path: string) => path);
  for (const [index, thread] of input.threads.entries()) {
    const activity = input.activities?.get(thread.threadId) ?? null;
    const markers = [
      input.boundThreadId === thread.threadId ? "bound" : null,
      threadActivityLabel(activity),
      `updated ${ageLabel(thread.updatedAt, input.now)}`,
    ].filter((marker): marker is string => Boolean(marker));
    lines.push(
      `${index + 1}. ${markers.join(" | ")}`,
      thread.threadId,
      `cwd: ${formatPath(thread.cwd)}`,
      `title: ${thread.title || "(untitled)"}`,
      `command: /teleport ${thread.threadId}`,
      "",
    );
  }
  return lines.join("\n").trimEnd();
}

export function renderTeleportSuccess(input: {
  binding: BoundThread;
  previousBinding?: BoundThread | null;
  status: ThreadTeleportStatus;
  formatPath?: (path: string) => string;
}): string {
  const formatPath = input.formatPath ?? ((path: string) => path);
  const lines = [
    "Telegram is now attached to this desktop Codex thread.",
    `Thread: ${shortThreadId(input.binding.threadId)} (verified)`,
    `CWD: ${formatPath(input.binding.cwd)}`,
    `Title: ${input.binding.title || "(untitled)"}`,
    `Mode: ${input.status.mode}`,
    `Owner: ${input.status.owner}`,
    `Queue: ${input.status.queueCount}`,
    `Pending approvals: ${input.status.pendingApprovals}`,
  ];
  if (input.previousBinding && input.previousBinding.threadId !== input.binding.threadId) {
    lines.push(`Back: /teleport ${input.previousBinding.threadId}`);
  }
  return lines.join("\n");
}
