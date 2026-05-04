const OPTIONAL_PREFIX = String.raw`^(?:hey\s+)?(?:please\s+)?(?:codex\s+)?(?:can you\s+|could you\s+)?`;
const OPTIONAL_SUFFIX_BODY = String.raw`(?:\s+(?:please|now|when ready|if you can))?`;
const OPTIONAL_SUFFIX = `${OPTIONAL_SUFFIX_BODY}$`;

const LAUNCH_PATTERNS = [
  new RegExp(`${OPTIONAL_PREFIX}call${OPTIONAL_SUFFIX}`),
  new RegExp(`${OPTIONAL_PREFIX}call me${OPTIONAL_SUFFIX}`),
  new RegExp(`${OPTIONAL_PREFIX}call me up${OPTIONAL_SUFFIX}`),
  new RegExp(`${OPTIONAL_PREFIX}give me (?:a )?(?:quick |live )?call${OPTIONAL_SUFFIX}`),
  new RegExp(`${OPTIONAL_PREFIX}give us (?:a )?(?:quick |live )?call${OPTIONAL_SUFFIX}`),
  new RegExp(`${OPTIONAL_PREFIX}(?:start|open|launch|arm|enable) (?:the )?(?:live )?call${OPTIONAL_SUFFIX}`),
  new RegExp(`${OPTIONAL_PREFIX}(?:start|open|launch|arm|enable) (?:a )?(?:live )?call${OPTIONAL_SUFFIX}`),
  new RegExp(`${OPTIONAL_PREFIX}(?:start|open|launch|arm|enable) live calling${OPTIONAL_SUFFIX}`),
  new RegExp(`${OPTIONAL_PREFIX}live call${OPTIONAL_SUFFIX}`),
  new RegExp(`${OPTIONAL_PREFIX}start calling${OPTIONAL_SUFFIX}`),
  new RegExp(String.raw`^(?:hey\s+)?(?:please\s+)?(?:codex\s+)?(?:let'?s|let us)\s+(?:jump|hop|get)\s+on\s+(?:a\s+)?call${OPTIONAL_SUFFIX}`),
];

const STATUS_PATTERNS = [
  /^(?:hey\s+)?(?:please\s+)?(?:what(?:'s| is)\s+)?(?:the\s+)?(?:live\s+)?call status$/,
  /^(?:hey\s+)?(?:please\s+)?(?:is\s+)?(?:the\s+)?(?:live\s+)?call ready$/,
  /^(?:hey\s+)?(?:please\s+)?status(?:\s+of)?\s+(?:the\s+)?(?:live\s+)?call$/,
];

export type TelegramCallIntent = "launch" | "status";

export function normalizeTelegramCallIntentText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’]/g, "'")
    .replace(/[^a-z0-9']+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function detectTelegramCallIntent(text: string): TelegramCallIntent | null {
  const normalized = normalizeTelegramCallIntentText(text);
  if (!normalized) {
    return null;
  }
  if (STATUS_PATTERNS.some(pattern => pattern.test(normalized))) {
    return "status";
  }
  if (LAUNCH_PATTERNS.some(pattern => pattern.test(normalized))) {
    return "launch";
  }
  return null;
}
