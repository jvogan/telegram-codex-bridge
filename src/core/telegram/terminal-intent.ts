const TERMINAL_TARGET = String.raw`(?:terminal\s+(?:codex|cli|lane|session|chat|mode)|codex\s+(?:terminal|cli))`;

export type TelegramTerminalIntent = "ask" | "connect" | "disconnect" | "ping";

export function normalizeTelegramTerminalIntentText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’]/g, "'")
    .replace(/[^a-z0-9']+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function cleanExtractedAskText(value: string | undefined): string | null {
  const cleaned = (value ?? "")
    .replace(/^\s*(?:to\s+)?[:,-]?\s*/i, "")
    .trim();
  if (/^(?:for\s+)?(?:chat|messages|everything|normal\s+messages|as\s+primary|mode)$/i.test(cleaned)) {
    return null;
  }
  return cleaned ? cleaned : null;
}

export function extractTelegramTerminalAskText(text: string): string | null {
  const target = TERMINAL_TARGET;
  const patterns = [
    new RegExp(String.raw`^\s*(?:please\s+)?(?:ask|tell)\s+(?:the\s+)?${target}\s+(?:to\s+)?([\s\S]+)$`, "i"),
    new RegExp(String.raw`^\s*(?:please\s+)?(?:use|have)\s+(?:the\s+)?${target}\s+(?:to\s+)?([\s\S]+)$`, "i"),
    new RegExp(String.raw`^\s*(?:please\s+)?(?:route|send)\s+(?:this\s+)?(?:to\s+)?(?:the\s+)?${target}\s*([\s\S]+)$`, "i"),
    new RegExp(String.raw`^\s*(?:the\s+)?${target}\s*[:,-]\s*([\s\S]+)$`, "i"),
  ];
  for (const pattern of patterns) {
    const extracted = cleanExtractedAskText(pattern.exec(text)?.[1]);
    if (extracted) {
      return extracted;
    }
  }
  return null;
}

export function detectTelegramTerminalIntent(text: string): TelegramTerminalIntent | null {
  const normalized = normalizeTelegramTerminalIntentText(text);
  if (!normalized) {
    return null;
  }
  if (/\b(?:disconnect|disable|turn\s+off|stop\s+using|leave)\s+(?:the\s+)?(?:terminal\s+(?:codex|cli|lane|session|chat|mode)|codex\s+(?:terminal|cli))\b/.test(normalized)
    || /\b(?:switch|go|return)\s+back\s+to\s+(?:the\s+)?(?:desktop|bound\s+desktop|codex\s+desktop|app|main\s+bridge)\b/.test(normalized)
    || /\bterminal\s+(?:chat|mode)\s+(?:off|disabled?)\b/.test(normalized)) {
    return "disconnect";
  }
  if (extractTelegramTerminalAskText(text)) {
    return "ask";
  }
  if (/\b(?:connect|switch|route|send|talk)\s+(?:me|telegram|bridge|chat|messages|everything|all\s+messages)?\s*(?:to|through|into)\s+(?:the\s+)?(?:terminal\s+(?:codex|cli|lane|session|chat|mode)|codex\s+(?:terminal|cli))\s*$/.test(normalized)
    || /\b(?:use|enable)\s+(?:the\s+)?(?:terminal\s+(?:codex|cli|lane|session|chat|mode)|codex\s+(?:terminal|cli))(?:\s+(?:for\s+)?(?:chat|messages|everything|normal\s+messages|as\s+primary|mode))?\s*$/.test(normalized)
    || /\b(?:keep|continue|stay|work)\s+(?:working\s+)?(?:with|in|on)\s+(?:the\s+)?(?:terminal|terminal\s+(?:codex|cli|lane|session|chat|mode)|codex\s+(?:terminal|cli))\s*$/.test(normalized)
    || /\blet's\s+(?:keep|continue|stay|work)\s+(?:working\s+)?(?:with|in|on)\s+(?:the\s+)?(?:terminal|terminal\s+(?:codex|cli|lane|session|chat|mode)|codex\s+(?:terminal|cli))\s*$/.test(normalized)
    || /\bterminal\s+(?:chat|mode)\s+(?:on|enabled?|connect(?:ed)?)\b/.test(normalized)) {
    return "connect";
  }
  const terminalTarget = TERMINAL_TARGET;
  const pingPatterns = [
    new RegExp(String.raw`\b(?:ping|poke|test)\s+(?:the\s+)?${terminalTarget}\b`),
    new RegExp(String.raw`\b${terminalTarget}\s+(?:ping|poke|test)\b`),
  ];
  if (pingPatterns.some(pattern => pattern.test(normalized))) {
    return "ping";
  }
  return null;
}
