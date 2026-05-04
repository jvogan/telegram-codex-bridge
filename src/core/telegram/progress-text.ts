export const TELEGRAM_PROGRESS_PREFIX = "Working on it.";

export function telegramProgressText(detail?: string): string {
  const cleaned = detail?.trim();
  return cleaned ? `${TELEGRAM_PROGRESS_PREFIX}\n${cleaned}` : TELEGRAM_PROGRESS_PREFIX;
}

export function telegramTurnStartText(): string {
  return "Starting now.";
}

export function telegramTurnSubmittedText(): string {
  return "Working on it. I'll send the result here when it's ready.";
}

export type TelegramTurnHeartbeatStage = "preparing" | "requesting" | "submitted";

export type TelegramTurnHeartbeatWorkload =
  | "simple_text"
  | "web_research"
  | "image_generation"
  | "visual_delivery"
  | "audio_reply"
  | "image_input"
  | "media_or_file_input";

function formatElapsedTime(elapsedMs: number): string {
  const totalSeconds = Math.max(1, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function workloadStatus(workload: TelegramTurnHeartbeatWorkload): string {
  switch (workload) {
    case "web_research":
      return "This can take a bit because web/tool work may involve multiple steps.";
    case "image_generation":
      return "Image generation can take a few minutes; I will attach the result when Codex surfaces it.";
    case "visual_delivery":
      return "I am watching for generated visual artifacts to send back here.";
    case "audio_reply":
      return "I will also prepare the requested audio reply after the text is ready.";
    case "image_input":
      return "The image has been handed to Codex for inspection.";
    case "media_or_file_input":
      return "The attachment has been handed to Codex for inspection.";
    case "simple_text":
    default:
      return "No final answer has arrived yet.";
  }
}

function stageStatus(stage: TelegramTurnHeartbeatStage, turnId?: string | null): string {
  switch (stage) {
    case "preparing":
      return "Preparing the request for Codex.";
    case "requesting":
      return "Submitting the request to Codex.";
    case "submitted":
      return turnId
        ? `Codex accepted the turn (${turnId.slice(0, 8)}...).`
        : "Codex accepted the turn.";
  }
}

export function telegramTurnHeartbeatText(input: {
  elapsedMs: number;
  stage: TelegramTurnHeartbeatStage;
  workload: TelegramTurnHeartbeatWorkload;
  turnId?: string | null;
}): string {
  return [
    "Still active.",
    `Elapsed: ${formatElapsedTime(input.elapsedMs)}.`,
    stageStatus(input.stage, input.turnId),
    workloadStatus(input.workload),
  ].join("\n");
}

export function telegramDirectImageHeartbeatText(input: { elapsedMs: number }): string {
  return [
    "Generating image...",
    `Elapsed: ${formatElapsedTime(input.elapsedMs)}.`,
    "Waiting on the bridge image provider.",
  ].join("\n");
}
