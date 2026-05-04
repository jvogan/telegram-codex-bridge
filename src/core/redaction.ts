import { createHash } from "node:crypto";

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function normalizeString(value: string | number): string {
  return String(value).trim();
}

function summarizeSensitiveText(value: string): string {
  const normalized = value.trim();
  const chars = normalized.length;
  const lines = normalized ? normalized.split(/\r?\n/).length : 0;
  return `[redacted text chars=${chars} lines=${lines} sha256=${shortHash(normalized)}]`;
}

function redactSecretValue(value: string): string {
  return `[redacted secret chars=${value.length} sha256=${shortHash(value)}]`;
}

function looksLikeUrl(value: string): boolean {
  return /^(?:https?|wss?):\/\//i.test(value);
}

function looksLikeRelativeUrl(value: string): boolean {
  return /^(?:\/|\.{1,2}\/|\?)/.test(value);
}

function normalizeSensitiveKeyName(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function looksSensitiveName(key: string): boolean {
  const normalized = normalizeSensitiveKeyName(key);
  return normalized === "auth"
    || normalized === "authorization"
    || normalized === "initdata"
    || normalized === "launch"
    || normalized === "ephemeral"
    || normalized.endsWith("token")
    || normalized.endsWith("secret")
    || normalized.endsWith("apikey")
    || normalized.endsWith("ephemeralkey");
}

function isSensitiveQueryKey(key: string): boolean {
  return looksSensitiveName(key);
}

function redactInlineSecretAssignments(value: string): string {
  return value.replace(
    /\b([a-z0-9_.-]+)\s*=\s*([^\s,;]+)/gi,
    (match, key: string) => (looksSensitiveName(key) ? `${key}=[redacted]` : match),
  );
}

function redactInlineSensitiveQueryPairs(value: string): string {
  return value.replace(
    /([?&])([^=&?#\s]+)=([^&#\s]+)/g,
    (match, prefix: string, key: string) => (looksSensitiveName(key) ? `${prefix}${key}=[redacted]` : match),
  );
}

function redactInlineSecrets(value: string): string {
  return redactInlineSecretAssignments(redactInlineSensitiveQueryPairs(value));
}

export function redactUrlForLogs(raw: string | null | undefined): string {
  if (!raw) {
    return "none";
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return "none";
  }
  const isAbsolute = looksLikeUrl(trimmed);
  const isRelative = looksLikeRelativeUrl(trimmed);
  try {
    if (!isAbsolute && !isRelative) {
      throw new Error("not a url");
    }
    const url = isAbsolute ? new URL(trimmed) : new URL(trimmed, "http://example.com");
    if (url.username) {
      url.username = "[redacted]";
    }
    if (url.password) {
      url.password = "[redacted]";
    }
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveQueryKey(key)) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    if (isAbsolute) {
      return url.toString();
    }
    if (trimmed.startsWith("?")) {
      return `${url.search}${url.hash}`;
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return redactInlineSecrets(trimmed);
  }
}

export function maskIdentifier(
  value: string | number | null | undefined,
  options: { start?: number; end?: number } = {},
): string {
  if (value === null || value === undefined) {
    return "none";
  }
  const normalized = normalizeString(value);
  if (!normalized) {
    return "none";
  }
  const start = options.start ?? 2;
  const end = options.end ?? 2;
  if (normalized.length <= start + end) {
    return `${"*".repeat(Math.max(2, normalized.length))} (${normalized.length} chars)`;
  }
  return `${normalized.slice(0, start)}...${normalized.slice(-end)} (${normalized.length} chars)`;
}

export function maskIpAddress(value: string | null | undefined): string {
  if (!value) {
    return "none";
  }
  if (value.includes(".")) {
    const octets = value.split(".");
    if (octets.length === 4) {
      return `${octets[0]}.${octets[1]}.${octets[2]}.x`;
    }
  }
  if (value.includes(":")) {
    const segments = value.split(":").filter(Boolean);
    if (segments.length >= 2) {
      return `${segments[0]}:${segments[1]}::[redacted]`;
    }
  }
  return "[redacted ip]";
}

function redactStringByKey(key: string, value: string): string {
  if (!value) {
    return value;
  }
  const sanitizedValue = redactInlineSecrets(value);
  if (/(^|_)(?:url|launchurl|healthurl)(?:$|_)/i.test(key) || looksLikeUrl(sanitizedValue) || looksLikeRelativeUrl(sanitizedValue)) {
    return redactUrlForLogs(sanitizedValue);
  }
  if (/(^|_)(?:token|secret|initdata|authorization|apikey|api_key|clienttoken|ephemeralkey)(?:$|_)/i.test(key)) {
    return redactSecretValue(sanitizedValue);
  }
  if (/(^|_)(?:clientip|ip)(?:$|_)/i.test(key)) {
    return maskIpAddress(sanitizedValue);
  }
  if (/(^|_)(?:chatid|authorizedchatid|configuredauthorizedchatid|userid|telegramuserid)(?:$|_)/i.test(key)) {
    return maskIdentifier(sanitizedValue);
  }
  if (/(^|_)(?:username|firstname|lastname|displayname)(?:$|_)/i.test(key)) {
    return "[redacted]";
  }
  if (/(^|_)(?:text|prompt|stdout|stderr|message)(?:$|_)/i.test(key)) {
    return summarizeSensitiveText(sanitizedValue);
  }
  if (/(^|_)(?:error|detail)(?:$|_)/i.test(key)) {
    return sanitizedValue;
  }
  return sanitizedValue;
}

function redactValue(keyPath: string[], value: unknown): unknown {
  const lastKey = keyPath[keyPath.length - 1]?.replace(/[^a-z0-9]+/gi, "_").toLowerCase() ?? "";
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => redactValue([...keyPath, String(index)], entry));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactValue([...keyPath, key], entry)]),
    );
  }
  if (typeof value === "string") {
    return redactStringByKey(lastKey, value);
  }
  if (typeof value === "number") {
    if (/(^|_)(?:chatid|authorizedchatid|configuredauthorizedchatid|userid|telegramuserid)(?:$|_)/i.test(lastKey)) {
      return maskIdentifier(value);
    }
    return value;
  }
  return value;
}

export function redactLogFields(fields?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!fields || Object.keys(fields).length === 0) {
    return undefined;
  }
  return redactValue([], fields) as Record<string, unknown>;
}
