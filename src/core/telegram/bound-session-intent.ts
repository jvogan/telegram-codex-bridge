const EXPLICIT_BOUND_SESSION_PATTERN = /\b(?:tell\s+(?:the\s+)?bound|bound\s+(?:to|thread|session|codex)|attached\s+(?:thread|session|codex)|current\s+(?:desktop\s+)?codex\s+(?:thread|session)|this\s+(?:desktop\s+)?codex\s+(?:thread|session)|same\s+session|update\s+(?:me\s+)?here|reply\s+here|report\s+back\s+here)\b/i;

const AGENT_SESSION_COMMAND_PATTERN = /\b(?:tell|ask|have|make|get)\s+(?:the\s+)?(?:agent|assistant|codex)\b[\s\S]{0,96}\b(?:session|here|reply|report|update|type|say|write|respond)\b/i;

const AGENT_SESSION_REFERENCE_PATTERN = /\b(?:agent|assistant|codex)\b[\s\S]{0,96}\b(?:its|this|the|your)\s+(?:own\s+)?session\b/i;

export function looksLikeBoundSessionRequest(text: string | undefined): boolean {
  const value = text?.replace(/\s+/g, " ").trim();
  if (!value) {
    return false;
  }
  return EXPLICIT_BOUND_SESSION_PATTERN.test(value)
    || AGENT_SESSION_COMMAND_PATTERN.test(value)
    || AGENT_SESSION_REFERENCE_PATTERN.test(value);
}
