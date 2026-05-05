import type { QueuedTelegramTask } from "../types.js";
import { looksLikeVisualDeliveryRequest } from "./tasks.js";

const TERMINAL_READONLY_TARGET_PATTERN = /\b(?:download|downloads|desktop|documents?|local\s+(?:file|folder|pdf|slides?)|pdf|slides?|pptx?|docx?|xlsx?|csv|log|logs?|repo|repository|workspace|folder|directory|file|web|online|internet|paper|papers|article|articles|source|sources|citation|citations|research)\b/i;
const TERMINAL_READONLY_ACTION_PATTERN = /\b(?:read|summari[sz]e|inspect|review|check|find|list|locate|look\s+at|show|display|grab|pull\s+up|analy[sz]e|extract|compare|search|grep|cat|tail|head|status|diagnose)\b/i;
const TERMINAL_EXPLICIT_PATTERN = /\b(?:use|try|route\s+to|send\s+to|ask)\s+(?:the\s+)?(?:terminal\s+(?:codex|cli|lane|session)|codex\s+(?:terminal|cli))\b/i;
const TERMINAL_UNSAFE_PATTERN = /\b(?:edit|modify|change|fix|implement|refactor|delete|remove|rename|move|install|deploy|publish|write\s+(?:to|in)|save\s+(?:to|in)\s+(?:the\s+)?(?:repo|repository|workspace)|(?:npm|pnpm|yarn)\s+(?:i|install|add)|git\s+(?:commit|push|pull|checkout|reset|merge)|commit\s+(?:it|changes?|this|the|to|in)|push\s+(?:to|this\s+branch|the\s+branch|origin|remote)|pull\s+(?:from|origin|remote)|checkout\s+(?:this\s+branch|the\s+branch|branch|main|master)|reset\s+(?:this|the|branch|repo|repository|workspace)|merge\s+(?:this|the|branch|main|master|into)|secret|token|api\s*key|password|credential|\.env|click|type\s+into|desktop\s+control|screen\s+share|call\s+me|live\s+call|voice\s+reply|reply\s+with\s+audio|make\s+(?:an?\s+)?image|generate\s+(?:an?\s+)?image|draw\s+(?:an?\s+)?(?:image|picture|photo|diagram|art|illustration|visual))\b/i;
const TERMINAL_SAFETY_PROHIBITION_PATTERN = /\b(?:do\s+not|don't|dont|without)\s+(?:(?:run|use)\s+tools?\s+(?:or|and)\s+)?(?:edit|modify|change|write\s+to|write\s+in|save\s+to|save\s+in)\s+(?:files?|repo|repository|workspace|anything)\b/gi;
const TERMINAL_PRIMARY_BRIDGE_PATTERN = /\b(?:make|generate|create|draw|diagram)\s+(?:an?\s+)?(?:image|picture|photo|diagram|art|illustration|visual)\b|\b(?:image\s*gen(?:eration)?|native\s+(?:codex\s+)?image\s*gen(?:eration)?|image\s+generation\s+tool)\b|\b(?:send|reply)\s+(?:with\s+)?(?:voice|audio|voice\s+note)\b|\b(?:voice|audio)\s+update\b|\b(?:speak|tts|text\s*to\s*speech|transcribe|asr|voice\s+note)\b|\b(?:(?:call|live\s+call)\s+(?:status|arm|disarm|hangup|hang\s+up|invite)|(?:status|arm|disarm|hangup|hang\s+up)\s+(?:the\s+)?(?:call|live\s+call))\b|\b(?:call\s+me|live\s+call|start\s+(?:a\s+)?call|mini\s*call|desktop\s+control|screen\s+share|screenshot|click|type\s+into|launch\s+(?:the\s+)?(?:app|browser|window)|open\s+(?:the\s+)?(?:app|browser|window))\b/i;
const TERMINAL_TELEGRAM_DELIVERY_PATTERN = /\b(?:show|display|send|attach|pull\s+up|bring\s+up|open)\b[\s\S]{0,72}\b(?:fig(?:ure)?|image|picture|photo|screenshot|diagram|chart|plot|graphic|gif|animation|video|clip)\b|\b(?:fig(?:ure)?|image|picture|photo|screenshot|diagram|chart|plot|graphic|gif|animation|video|clip)\b[\s\S]{0,72}\b(?:show|display|send|attach|pull\s+up|bring\s+up|open)\b|\b(?:send|attach|return|give\s+me)\b[\s\S]{0,72}\b(?:pdf|document|report|slides?|deck|spreadsheet|audio|voice\s+note)\b/i;
const TERMINAL_HARD_BLOCK_PATTERN = /\b(?:deploy|publish|npm\s+(?:i|install|add)|pnpm\s+(?:add|i|install)|yarn\s+(?:add|i|install)|git\s+(?:commit|push|pull|checkout|reset|merge)|push\s+(?:to|this\s+branch|the\s+branch|origin|remote)|pull\s+(?:from|origin|remote)|checkout\s+(?:this\s+branch|the\s+branch|branch|main|master)|reset\s+(?:this|the|branch|repo|repository|workspace)|merge\s+(?:this|the|branch)|secret|token|api\s*key|password|credential|\.env|rm\s+-rf|sudo)\b/i;
const TERMINAL_WORKSPACE_MUTATION_PATTERN = /\b(?:apply\s+patch|edit|modify|change|fix|implement|refactor|delete|remove|rename|move|write\s+(?:to|in)|save\s+(?:to|in)\s+(?:the\s+)?(?:repo|repository|workspace)|update\s+(?:the\s+)?(?:file|repo|repository|workspace))\b/i;
const TELEGRAM_AUDIO_PLACEHOLDER_TEXTS = new Set(["(voice message)", "(audio attachment)"]);

export type TerminalRouteDecision =
  | { route: "terminal"; reason: string }
  | { route: "primary"; reason: string };

function textWithoutSafetyProhibitions(text: string): string {
  return text.replace(TERMINAL_SAFETY_PROHIBITION_PATTERN, "");
}

export function terminalRequestTextForTask(task: QueuedTelegramTask): string {
  const text = task.text.trim();
  if (task.kind !== "voice" && task.kind !== "audio") {
    return text;
  }
  const transcript = task.transcriptText?.trim() ?? "";
  if (!transcript) {
    return "";
  }
  if (!text || TELEGRAM_AUDIO_PLACEHOLDER_TEXTS.has(text.toLowerCase())) {
    return transcript;
  }
  return `${text}\n\nTranscript:\n${transcript}`;
}

export function isTerminalUnsafeRequest(text: string): boolean {
  return TERMINAL_UNSAFE_PATTERN.test(textWithoutSafetyProhibitions(text));
}

export function isTerminalPrimaryBridgeRequest(text: string): boolean {
  const cleaned = textWithoutSafetyProhibitions(text);
  return TERMINAL_PRIMARY_BRIDGE_PATTERN.test(cleaned)
    || TERMINAL_TELEGRAM_DELIVERY_PATTERN.test(cleaned)
    || looksLikeVisualDeliveryRequest(cleaned);
}

export function isTerminalHardBlockedRequest(text: string): boolean {
  return TERMINAL_HARD_BLOCK_PATTERN.test(textWithoutSafetyProhibitions(text));
}

export function isTerminalWorkspaceMutationRequest(text: string): boolean {
  return TERMINAL_WORKSPACE_MUTATION_PATTERN.test(textWithoutSafetyProhibitions(text));
}

export function terminalConversationBlocker(text: string, options: { allowWorkspaceWrites: boolean }): string | null {
  if (isTerminalHardBlockedRequest(text)) {
    return "Terminal chat mode blocks deploys, installs, destructive git/file operations, sudo, and secret/credential requests.";
  }
  if (isTerminalPrimaryBridgeRequest(text)) {
    return "Terminal chat mode leaves native image/audio, live-call, and desktop-control work on the bound desktop bridge path.";
  }
  if (isTerminalWorkspaceMutationRequest(text) && !options.allowWorkspaceWrites) {
    return "Terminal chat mode is read-only for this terminal profile. Switch to the explicit power-user profile before asking it to modify files.";
  }
  return null;
}

export function terminalExplicitAskBlocker(text: string, options: { allowWorkspaceWrites: boolean }): string | null {
  if (isTerminalHardBlockedRequest(text)) {
    return "Terminal ask blocks deploys, installs, destructive git/file operations, sudo, and secret/credential requests.";
  }
  if (isTerminalPrimaryBridgeRequest(text)) {
    return "Terminal ask leaves native image/audio, live-call, and desktop-control work on the bound desktop bridge path.";
  }
  if (isTerminalWorkspaceMutationRequest(text) && !options.allowWorkspaceWrites) {
    return "Terminal ask is read-only for this terminal profile. Switch to the explicit power-user profile before asking it to modify files.";
  }
  return null;
}

export function terminalRouteCanBypassHold(holdReason: string | null, options: {
  terminalConversationMode?: boolean;
} = {}): boolean {
  if (!holdReason || holdReason === "desktop_turn_active") {
    return true;
  }
  if (options.terminalConversationMode && (holdReason === "unbound" || holdReason === "codex_busy")) {
    return true;
  }
  return false;
}

export function selectTerminalRouteForTask(task: QueuedTelegramTask, options: {
  desktopBusy: boolean;
  terminalBusy?: boolean;
  terminalConversationMode?: boolean;
}): TerminalRouteDecision {
  if (options.terminalBusy) {
    return { route: "primary", reason: "terminal_busy" };
  }
  const text = terminalRequestTextForTask(task);
  if (task.kind === "text" || task.kind === "voice" || task.kind === "audio") {
    if (options.terminalConversationMode && text) {
      if (isTerminalPrimaryBridgeRequest(text)) {
        return { route: "primary", reason: "terminal_chat_primary_bridge_request" };
      }
      return { route: "terminal", reason: "terminal_chat_mode" };
    }
    if (text && TERMINAL_EXPLICIT_PATTERN.test(text) && !isTerminalUnsafeRequest(text)) {
      return { route: "terminal", reason: "explicit_terminal_request" };
    }
  }
  if (options.terminalConversationMode && task.kind === "document" && !isTerminalUnsafeRequest(task.text)) {
    return { route: "terminal", reason: "terminal_chat_document" };
  }
  if (!options.desktopBusy) {
    return { route: "primary", reason: "desktop_not_busy" };
  }
  if (task.kind === "document") {
    if (isTerminalUnsafeRequest(task.text)) {
      return { route: "primary", reason: "document_request_not_readonly" };
    }
    return { route: "terminal", reason: "document_readonly_desktop_busy" };
  }
  if (task.kind !== "text" && task.kind !== "voice" && task.kind !== "audio") {
    return { route: "primary", reason: "unsupported_terminal_task_kind" };
  }
  if (!text) {
    return { route: "primary", reason: "empty_text" };
  }
  if (isTerminalPrimaryBridgeRequest(text)) {
    return { route: "primary", reason: "primary_bridge_request" };
  }
  if (isTerminalUnsafeRequest(text)) {
    return { route: "primary", reason: "not_readonly" };
  }
  if (TERMINAL_READONLY_ACTION_PATTERN.test(text) && TERMINAL_READONLY_TARGET_PATTERN.test(text)) {
    return { route: "terminal", reason: "readonly_local_or_repo_request_desktop_busy" };
  }
  return { route: "primary", reason: "no_terminal_intent" };
}

function terminalReadonlyPrefix(): string {
  return [
    "Telegram routed this to the terminal Codex lane because the bound desktop Codex turn was busy.",
    "Terminal lane v1 is read-only and artifact-only: do not edit, delete, rename, install, deploy, commit, push, or otherwise mutate workspace/repo files.",
    "If the request requires native image generation, Telegram media delivery, live calls, desktop UI control, approvals, secrets, or workspace mutations, say that it should run on the bound desktop bridge path instead.",
    "If you create or extract a deliverable file, save it under an output directory inside the current workspace or bridge repo, not /tmp, and mention the saved path.",
  ].join(" ");
}

function terminalConversationPrefix(options: { allowWorkspaceWrites: boolean }): string {
  if (!options.allowWorkspaceWrites) {
    return [
      "Telegram is connected to the terminal Codex lane as the primary chat target.",
      "This terminal profile is read-only and artifact-only: do not edit, delete, rename, install, deploy, commit, push, or otherwise mutate workspace/repo files.",
      "If the request requires native image generation, Telegram media delivery, live calls, desktop UI control, approvals, secrets, or workspace mutations, say that it should run on the bound desktop bridge path instead.",
      "If you create or extract a deliverable file, save it under an output directory inside the current workspace or bridge repo, not /tmp, and mention the saved path.",
    ].join(" ");
  }
  return [
    "Telegram is connected to the terminal Codex lane as the primary chat target.",
    "Handle the user request like a normal Codex CLI task within the configured workspace-write sandbox and approval policy.",
    "You may edit files in the configured workspace when the request clearly requires it, but do not deploy, publish, install new dependencies, access secrets, run destructive git/file operations, use sudo, control desktop apps, handle live calls, or use native image/audio generation.",
    "If you create or extract a deliverable file, save it under an output directory inside the current workspace or bridge repo, not /tmp, and mention the saved path so the bridge can attach it.",
    "Keep the final answer concise and mention changed files when you modify the workspace.",
  ].join(" ");
}

function terminalExplicitPrefix(options: { allowWorkspaceWrites: boolean }): string {
  if (!options.allowWorkspaceWrites) {
    return terminalReadonlyPrefix();
  }
  return [
    "Telegram sent this as an explicit terminal Codex lane task.",
    "Handle the user request like a normal Codex CLI task within the configured workspace-write sandbox and approval policy.",
    "You may edit files in the configured workspace when the request clearly requires it, but do not deploy, publish, install new dependencies, access secrets, run destructive git/file operations, use sudo, control desktop apps, handle live calls, or use native image/audio generation.",
    "If you create or extract a deliverable file, save it under an output directory inside the current workspace or bridge repo, not /tmp, and mention the saved path so the bridge can attach it.",
    "Keep the final answer concise and mention changed files when you modify the workspace.",
  ].join(" ");
}

export function buildTerminalPromptForText(text: string): string {
  return [
    terminalReadonlyPrefix(),
    `User request: ${text}`,
  ].join("\n");
}

export function buildTerminalConversationPromptForText(text: string, options: { allowWorkspaceWrites: boolean }): string {
  return [
    terminalConversationPrefix(options),
    `User request: ${text}`,
  ].join("\n");
}

export function buildTerminalExplicitPromptForText(text: string, options: { allowWorkspaceWrites: boolean }): string {
  return [
    terminalExplicitPrefix(options),
    `User request: ${text}`,
  ].join("\n");
}

export function buildTerminalPromptForTask(task: QueuedTelegramTask): string {
  if (task.kind === "document") {
    return [
      terminalReadonlyPrefix(),
      `User request: ${task.text || "Inspect the attached document."}`,
      `Document file name: ${task.documentFileName ?? "unknown"}`,
      `Document MIME type: ${task.documentMimeType ?? "unknown"}`,
      task.documentPath
        ? `Staged document path for local inspection: ${task.documentPath}`
        : "The document has not been staged yet; say that the terminal lane could not access the attachment.",
    ].join("\n");
  }

  return buildTerminalPromptForText(terminalRequestTextForTask(task) || task.text);
}

export function buildTerminalConversationPromptForTask(task: QueuedTelegramTask, options: { allowWorkspaceWrites: boolean }): string {
  if (task.kind === "document") {
    return [
      terminalConversationPrefix(options),
      `User request: ${task.text || "Inspect the attached document."}`,
      `Document file name: ${task.documentFileName ?? "unknown"}`,
      `Document MIME type: ${task.documentMimeType ?? "unknown"}`,
      task.documentPath
        ? `Staged document path for local inspection: ${task.documentPath}`
        : "The document has not been staged yet; say that the terminal lane could not access the attachment.",
    ].join("\n");
  }

  return buildTerminalConversationPromptForText(terminalRequestTextForTask(task) || task.text, options);
}
