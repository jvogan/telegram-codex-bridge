export interface GatewaySecurityHeaders {
  [key: string]: string | string[] | undefined;
  "x-forwarded-for"?: string | string[] | undefined;
  "cf-ray"?: string | string[] | undefined;
  "cf-connecting-ip"?: string | string[] | undefined;
}

export interface TimedAttemptReservation {
  key: string;
  token: number;
}

export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) {
    return false;
  }
  return address === "::1"
    || address === "127.0.0.1"
    || address === "::ffff:127.0.0.1";
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0]?.trim() || null;
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return null;
}

export function resolveGatewayClientIp(
  remoteAddress: string | null | undefined,
  headers: GatewaySecurityHeaders,
): string {
  const effectiveRemoteAddress = remoteAddress || "unknown";
  if (!isLoopbackAddress(effectiveRemoteAddress)) {
    return effectiveRemoteAddress;
  }
  const forwardedHeaderPresent = Boolean(
    firstHeaderValue(headers["cf-ray"])
    || firstHeaderValue(headers["cf-connecting-ip"])
    || firstHeaderValue(headers["x-forwarded-for"]),
  );
  if (forwardedHeaderPresent) {
    return effectiveRemoteAddress;
  }
  return effectiveRemoteAddress;
}

export function registerTimedAttempt(
  map: Map<string, number[]>,
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): { count: number; limitReached: boolean } {
  const entries = (map.get(key) ?? []).filter(timestamp => now - timestamp < windowMs);
  entries.push(now);
  map.set(key, entries);
  return {
    count: entries.length,
    limitReached: entries.length >= limit,
  };
}

export function pruneTimedAttempts(
  map: Map<string, number[]>,
  key: string,
  now: number,
  windowMs: number,
): number[] {
  const entries = (map.get(key) ?? []).filter(timestamp => now - timestamp < windowMs);
  if (entries.length === 0) {
    map.delete(key);
    return [];
  }
  map.set(key, entries);
  return entries;
}

export function hasTimedAttemptCapacity(
  map: Map<string, number[]>,
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): boolean {
  return pruneTimedAttempts(map, key, now, windowMs).length < limit;
}

export function recordTimedAttempt(
  map: Map<string, number[]>,
  key: string,
  now = Date.now(),
): void {
  const entries = pruneTimedAttempts(map, key, now, Number.POSITIVE_INFINITY);
  entries.push(now);
  map.set(key, entries);
}

export function refundTimedAttempt(
  map: Map<string, number[]>,
  key: string,
): void {
  const entries = map.get(key);
  if (!entries || entries.length === 0) {
    return;
  }
  entries.pop();
  if (entries.length === 0) {
    map.delete(key);
    return;
  }
  map.set(key, entries);
}

function nextTimedAttemptToken(entries: number[], now: number): number {
  let token = now;
  while (entries.includes(token)) {
    token += 0.001;
  }
  return token;
}

export function reserveTimedAttempt(
  map: Map<string, number[]>,
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): TimedAttemptReservation | null {
  const entries = pruneTimedAttempts(map, key, now, windowMs);
  if (entries.length >= limit) {
    return null;
  }
  const token = nextTimedAttemptToken(entries, now);
  entries.push(token);
  map.set(key, entries);
  return { key, token };
}

export function releaseTimedAttempt(
  map: Map<string, number[]>,
  reservation: TimedAttemptReservation | null | undefined,
): void {
  if (!reservation) {
    return;
  }
  const entries = map.get(reservation.key);
  if (!entries || entries.length === 0) {
    return;
  }
  const index = entries.indexOf(reservation.token);
  if (index === -1) {
    return;
  }
  entries.splice(index, 1);
  if (entries.length === 0) {
    map.delete(reservation.key);
    return;
  }
  map.set(reservation.key, entries);
}
