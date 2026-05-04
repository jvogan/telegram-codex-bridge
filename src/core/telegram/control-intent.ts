const RECONNECT_PATTERNS = [
  /^(?:please\s+)?(?:can you\s+|could you\s+|would you\s+|are you able to\s+)?(?:restart|reconnect|rebind|reattach)\s+(?:the\s+)?(?:telegram\s+)?(?:bridge|daemon|session|binding|bot)$/,
  /^(?:please\s+)?(?:can you\s+|could you\s+|would you\s+|are you able to\s+)?(?:restart|reconnect|rebind|reattach)\s+(?:the\s+)?(?:telegram\s+)?(?:bridge|daemon|session|binding|bot)\s+(?:again|now|for me|on your own)$/,
  /^(?:please\s+)?(?:can you\s+|could you\s+|would you\s+|are you able to\s+)?(?:restart|reconnect|rebind|reattach)(?:\s+the)?\s+reconnect(?:ion|ing)?(?:\s+on your own)?$/,
  /^(?:please\s+)?(?:can you\s+|could you\s+|would you\s+|are you able to\s+)?(?:restart|reconnect|rebind|reattach)\b[\s\S]{0,32}\b(?:on your own|yourself)$/,
];

export type TelegramControlIntent = "reconnect";

export function normalizeTelegramControlIntentText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['\u2019]/g, "'")
    .replace(/[^a-z0-9']+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function detectTelegramControlIntent(text: string): TelegramControlIntent | null {
  const normalized = normalizeTelegramControlIntentText(text);
  if (!normalized) {
    return null;
  }
  if (RECONNECT_PATTERNS.some(pattern => pattern.test(normalized))) {
    return "reconnect";
  }
  return null;
}
