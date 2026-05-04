import type { QueuedTelegramTask } from "../types.js";

export function describeTelegramQueueHoldReason(reason: string | null): string | null {
  switch (reason) {
    case "call_active":
      return "a live call is active";
    case "call_enable_pending":
      return "live calling is starting";
    case "call_finalizing":
      return "a completed live call is being finalized";
    case "codex_busy":
    case "desktop_turn_active":
      return "another reply is in progress";
    case "desktop_turn_unverified":
      return "the current reply status is settling";
    case "fallback_unavailable":
      return "the safe fallback lane is not ready";
    case "sleeping":
    case "owner:desktop":
      return "chat processing is paused";
    case "owner:none":
      return "chat processing is not active yet";
    case "unbound":
      return "chat processing is not connected yet";
    default:
      return null;
  }
}

export function buildQueuedPlaceholder(
  task: Pick<QueuedTelegramTask, "kind">,
  aheadCount: number,
  holdReason: string | null,
): string {
  const lines: string[] = [];
  if (aheadCount > 0) {
    lines.push(`Queued behind ${aheadCount} earlier ${aheadCount === 1 ? "request" : "requests"}.`);
  } else {
    lines.push("One moment.");
  }

  const holdDescription = describeTelegramQueueHoldReason(holdReason);
  if (holdDescription) {
    lines.push(`Waiting because ${holdDescription}.`);
  } else {
    lines.push("I'll continue automatically as soon as the current work is clear.");
  }

  if (task.kind === "image") {
    lines.push("I'm preparing the image while this waits.");
  }
  if (task.kind === "document") {
    lines.push("I'll fetch the file as soon as this starts.");
  }
  if (task.kind === "voice" || task.kind === "audio") {
    lines.push("I'll transcribe the audio as soon as this starts.");
  }
  if (task.kind === "video") {
    lines.push("I'll prepare the video as soon as this starts.");
  }
  return lines.join("\n");
}
