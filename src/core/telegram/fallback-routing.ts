import type { BridgeLane, QueuedTelegramTask } from "../types.js";
import { looksLikeBoundSessionRequest } from "./bound-session-intent.js";
import { looksLikeImageGenerationRequest } from "./tasks.js";

const FALLBACK_HARD_BLOCK_PATTERN = /\b(?:deploy|publish|commit|merge|push|pull|checkout|reset|install|npm\s+install|pnpm|yarn|git|secret|token|api\s*key|password|credential|\.env|desktop|click|open\s+(?:the\s+)?(?:app|browser|window)|screenshot|screen\s+share|terminal|shell|command|sudo|rm\s+-rf)\b/i;
const FALLBACK_WORKSPACE_MUTATION_REQUEST_PATTERN = /\b(?:apply\s+patch|edit|modify|change|fix|implement|refactor|delete|remove|rename|move|npm\s+(?:run|test|build)|write\s+(?:to\s+)?(?:(?:a|the|this|that)\s+)?(?:file|repo|repository|workspace)|save\s+(?:to|in)\s+(?:the\s+)?(?:repo|repository|workspace))\b/i;

export interface FallbackRoutingPolicy {
  enabled: boolean;
  allowWorkspaceWrites: boolean;
}

export function isFallbackEligibleTelegramTask(
  task: Pick<QueuedTelegramTask, "kind" | "text">,
  policy: FallbackRoutingPolicy,
): boolean {
  if (!policy.enabled) {
    return false;
  }
  const text = task.text.replace(/\s+/g, " ").trim();
  if (FALLBACK_HARD_BLOCK_PATTERN.test(text)) {
    return false;
  }
  if (!policy.allowWorkspaceWrites && FALLBACK_WORKSPACE_MUTATION_REQUEST_PATTERN.test(text)) {
    return false;
  }
  if (looksLikeBoundSessionRequest(text)) {
    return false;
  }
  if (task.kind !== "text") {
    return true;
  }
  if (looksLikeImageGenerationRequest(text)) {
    return true;
  }
  return text.length > 0;
}

export function selectTelegramTaskLane(input: {
  task: Pick<QueuedTelegramTask, "kind" | "text">;
  holdReason: string | null;
  policy: FallbackRoutingPolicy;
}): BridgeLane {
  if (!input.holdReason) {
    return "primary";
  }
  if (
    input.holdReason === "desktop_turn_active"
    && isFallbackEligibleTelegramTask(input.task, input.policy)
  ) {
    return "fallback";
  }
  return "primary";
}
