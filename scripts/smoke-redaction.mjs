const PRIVATE_PATH_PATTERN = /(?:\/Users\/|\/home\/)[^/\s)]+\/[^\s)]+/g;
const SENSITIVE_ASSIGNMENT_PATTERN = /\b([A-Z][A-Z0-9_]*(?:API_KEY|KEY|TOKEN|SECRET))=([^\s"'`]+)/g;
const JSON_STRING_PAIR_PATTERN = /("?([A-Za-z0-9_-]+)"?\s*:\s*)"([^"]+)"/g;

function looksSensitiveSmokeKey(key) {
  return /^(?:key|token|secret)$/i.test(key)
    || /(?:api[_-]?key|token|secret|launch)$/i.test(key);
}

export function redactSmokeValue(value) {
  return String(value)
    .replace(PRIVATE_PATH_PATTERN, "[redacted-path]")
    .replace(/(launch=)[^&\s)]+/g, "$1[redacted]")
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, "$1=[redacted]")
    .replace(JSON_STRING_PAIR_PATTERN, (match, prefix, key) => (
      looksSensitiveSmokeKey(key) ? `${prefix}"[redacted]"` : match
    ));
}

export function redactSmokeJson(value) {
  if (typeof value === "string") {
    return redactSmokeValue(value);
  }
  if (Array.isArray(value)) {
    return value.map(item => redactSmokeJson(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (looksSensitiveSmokeKey(key)) {
          return [key, "[redacted]"];
        }
        return [key, redactSmokeJson(item)];
      }),
    );
  }
  return value;
}
