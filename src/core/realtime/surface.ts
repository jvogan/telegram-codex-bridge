import { randomUUID } from "node:crypto";

import type { BridgeConfig } from "../config.js";
import type { RealtimeCallSurfaceEvent, RealtimeCallSurfaceRecord, RealtimeTunnelMode } from "../types.js";

export type RealtimeCallSurfaceStatusLabel = "disarmed" | "arming" | "ready" | "active" | "cooling-down";
const MAX_RECENT_CALL_SURFACE_EVENTS = 6;

export function getRealtimeTunnelMode(config: BridgeConfig): RealtimeTunnelMode {
  return config.realtime.tunnel_mode ?? (config.realtime.public_url ? "static-public-url" : "managed-quick-cloudflared");
}

export function getDefaultCallSurfaceRecord(config: BridgeConfig): RealtimeCallSurfaceRecord {
  return {
    armed: false,
    armedAt: null,
    armedBy: null,
    expiresAt: null,
    lastActivityAt: null,
    lastPublicProbeAt: null,
    lastPublicProbeReady: null,
    lastPublicProbeDetail: null,
    lastPublicUrl: null,
    lastHealthUrl: null,
    lastLaunchUrl: null,
    lastDisarmReason: null,
    launchTokenId: null,
    launchTokenBridgeId: null,
    launchTokenTelegramUserId: null,
    launchTokenTelegramChatInstance: null,
    launchTokenReservedAt: null,
    launchTokenExpiresAt: null,
    tunnelMode: getRealtimeTunnelMode(config),
    tunnelPid: null,
    tunnelUrl: null,
    tunnelStartedAt: null,
    recentEvents: [],
  };
}

export function isLaunchTokenValid(
  surface: RealtimeCallSurfaceRecord,
  token: string | null | undefined,
  options: {
    now?: number;
    bridgeId?: string | null | undefined;
    telegramUserId?: string | null | undefined;
    telegramChatInstance?: string | null | undefined;
  } = {},
): boolean {
  const now = options.now ?? Date.now();
  return Boolean(
    surface.armed
    && token
    && surface.launchTokenId
    && token === surface.launchTokenId
    && (!surface.launchTokenBridgeId || !options.bridgeId || options.bridgeId === surface.launchTokenBridgeId)
    && (!surface.launchTokenTelegramUserId || !options.telegramUserId || options.telegramUserId === surface.launchTokenTelegramUserId)
    && (!surface.launchTokenTelegramChatInstance
      || !options.telegramChatInstance
      || options.telegramChatInstance === surface.launchTokenTelegramChatInstance)
    && surface.launchTokenExpiresAt
    && surface.launchTokenExpiresAt > now,
  );
}

export function hasOutstandingLaunchToken(surface: RealtimeCallSurfaceRecord, now = Date.now()): boolean {
  return Boolean(surface.launchTokenId && surface.launchTokenExpiresAt && surface.launchTokenExpiresAt > now);
}

export function resolvePublicBaseUrl(config: BridgeConfig, surface: RealtimeCallSurfaceRecord): string | null {
  if (!config.realtime.enabled) {
    return null;
  }
  if (surface.tunnelMode === "managed-quick-cloudflared") {
    return surface.tunnelUrl?.replace(/\/$/, "") ?? null;
  }
  return config.realtime.public_url ? config.realtime.public_url.replace(/\/$/, "") : null;
}

export function buildSurfaceLaunchUrl(
  config: BridgeConfig,
  surface: RealtimeCallSurfaceRecord,
): string | null {
  const publicBaseUrl = resolvePublicBaseUrl(config, surface);
  if (!publicBaseUrl || !surface.launchTokenId || !surface.launchTokenExpiresAt || surface.launchTokenExpiresAt <= Date.now()) {
    return null;
  }
  return `${publicBaseUrl}/miniapp?bridgeId=${encodeURIComponent(config.realtime.bridge_id)}&launch=${encodeURIComponent(surface.launchTokenId)}`;
}

export function mintLaunchToken(
  config: BridgeConfig,
  surface: RealtimeCallSurfaceRecord,
  armedBy: string,
  now = Date.now(),
): RealtimeCallSurfaceRecord {
  return {
    ...surface,
    armed: true,
    armedAt: now,
    armedBy,
    expiresAt: now + config.realtime.auto_disarm_idle_ms,
    lastActivityAt: now,
    lastPublicProbeAt: null,
    lastPublicProbeReady: null,
    lastPublicProbeDetail: null,
    lastPublicUrl: null,
    lastHealthUrl: null,
    lastLaunchUrl: null,
    lastDisarmReason: null,
    launchTokenId: randomUUID(),
    launchTokenBridgeId: config.realtime.bridge_id,
    launchTokenTelegramUserId: config.telegram.authorized_chat_id,
    launchTokenTelegramChatInstance: null,
    launchTokenReservedAt: null,
    launchTokenExpiresAt: now + config.realtime.launch_token_ttl_ms,
  };
}

export function invalidateLaunchToken(surface: RealtimeCallSurfaceRecord): RealtimeCallSurfaceRecord {
  return {
    ...surface,
    launchTokenId: null,
    launchTokenBridgeId: null,
    launchTokenTelegramUserId: null,
    launchTokenTelegramChatInstance: null,
    launchTokenReservedAt: null,
    launchTokenExpiresAt: null,
  };
}

export function reserveLaunchTokenChatInstance(
  surface: RealtimeCallSurfaceRecord,
  telegramChatInstance: string | null | undefined,
  now = Date.now(),
): RealtimeCallSurfaceRecord {
  if (!surface.armed || !surface.launchTokenId || !telegramChatInstance || surface.launchTokenTelegramChatInstance) {
    return surface;
  }
  return {
    ...surface,
    launchTokenTelegramChatInstance: telegramChatInstance,
    launchTokenReservedAt: now,
  };
}

export function releaseLaunchTokenReservation(
  surface: RealtimeCallSurfaceRecord,
  options: {
    token?: string | null | undefined;
  } = {},
): RealtimeCallSurfaceRecord {
  if (!surface.launchTokenTelegramChatInstance) {
    return surface;
  }
  if (options.token && surface.launchTokenId && options.token !== surface.launchTokenId) {
    return surface;
  }
  return {
    ...surface,
    launchTokenTelegramChatInstance: null,
    launchTokenReservedAt: null,
  };
}

export function cleanupStaleLaunchTokenReservation(
  surface: RealtimeCallSurfaceRecord,
  now = Date.now(),
  staleReservationMs = 120_000,
): RealtimeCallSurfaceRecord {
  if (!surface.launchTokenTelegramChatInstance) {
    return surface;
  }
  const tokenExpired = !surface.launchTokenId || !surface.launchTokenExpiresAt || surface.launchTokenExpiresAt <= now;
  const reservationExpired = Boolean(
    surface.launchTokenReservedAt !== null
    && surface.launchTokenReservedAt !== undefined
    && staleReservationMs > 0
    && now - surface.launchTokenReservedAt >= staleReservationMs,
  );
  if (!tokenExpired && !reservationExpired) {
    return surface;
  }
  return {
    ...surface,
    launchTokenTelegramChatInstance: null,
    launchTokenReservedAt: null,
  };
}

export function disarmCallSurface(surface: RealtimeCallSurfaceRecord): RealtimeCallSurfaceRecord {
  return {
    ...surface,
    armed: false,
    armedAt: null,
    armedBy: null,
    expiresAt: null,
    lastActivityAt: null,
    launchTokenId: null,
    launchTokenBridgeId: null,
    launchTokenTelegramUserId: null,
    launchTokenTelegramChatInstance: null,
    launchTokenReservedAt: null,
    launchTokenExpiresAt: null,
    tunnelPid: null,
    tunnelUrl: null,
    tunnelStartedAt: null,
  };
}

export function recordPublicSurfaceProbe(
  surface: RealtimeCallSurfaceRecord,
  probe: {
    ready: boolean;
    detail: string;
    publicUrl: string | null;
    healthUrl: string | null;
    launchUrl: string | null;
  },
  now = Date.now(),
): RealtimeCallSurfaceRecord {
  return {
    ...surface,
    lastPublicProbeAt: now,
    lastPublicProbeReady: probe.ready,
    lastPublicProbeDetail: probe.detail,
    lastPublicUrl: probe.publicUrl,
    lastHealthUrl: probe.healthUrl,
    lastLaunchUrl: probe.launchUrl,
  };
}

export function recordCallSurfaceDisarmReason(
  surface: RealtimeCallSurfaceRecord,
  reason: string,
): RealtimeCallSurfaceRecord {
  return {
    ...surface,
    lastDisarmReason: reason,
  };
}

export function recordCallSurfaceEvent(
  surface: RealtimeCallSurfaceRecord,
  event: RealtimeCallSurfaceEvent,
  limit = MAX_RECENT_CALL_SURFACE_EVENTS,
): RealtimeCallSurfaceRecord {
  return {
    ...surface,
    recentEvents: [...(surface.recentEvents ?? []), event].slice(-limit),
  };
}

export function describeRememberedDisarmedCallSurface(surface: RealtimeCallSurfaceRecord): string | null {
  if (surface.armed || !surface.lastDisarmReason) {
    return null;
  }
  if (surface.lastDisarmReason === "bridgectl call disarm") {
    return "call surface was manually disarmed; run `bridgectl call arm` to mint a fresh invite";
  }
  if (surface.lastDisarmReason.includes("public_unreachable") && surface.lastPublicProbeDetail) {
    return `call surface is disarmed (last failure: ${surface.lastPublicProbeDetail})`;
  }
  if (surface.lastDisarmReason.includes("gateway_disconnected")) {
    return "call surface is disarmed (gateway control channel disconnected)";
  }
  if (surface.lastDisarmReason.includes("tunnel_missing")) {
    return "call surface is disarmed (managed tunnel exited)";
  }
  if (surface.lastDisarmReason.includes("idle")) {
    return "call surface is disarmed (idle timeout)";
  }
  return `call surface is disarmed (${surface.lastDisarmReason})`;
}

export function describeLaunchTokenState(surface: RealtimeCallSurfaceRecord, now = Date.now()): string {
  if (!surface.armed) {
    return describeRememberedDisarmedCallSurface(surface) ?? "call surface is disarmed";
  }
  if (!surface.launchTokenId) {
    return "launch token was already consumed by a client; run `bridgectl call arm` to mint a fresh invite";
  }
  if (!surface.launchTokenExpiresAt) {
    return "launch token metadata is missing; run `bridgectl call arm` to mint a fresh invite";
  }
  if (surface.launchTokenExpiresAt <= now) {
    return "launch token expired; run `bridgectl call arm` to mint a fresh invite";
  }
  if (surface.launchTokenTelegramChatInstance) {
    return "launch token is reserved for an in-progress Telegram Mini App session; if that launch is stuck, send `/call` again to mint a fresh invite";
  }
  return "launch token is ready";
}

export function touchCallSurfaceActivity(
  config: BridgeConfig,
  surface: RealtimeCallSurfaceRecord,
  now = Date.now(),
): RealtimeCallSurfaceRecord {
  return {
    ...surface,
    lastActivityAt: now,
    expiresAt: now + config.realtime.auto_disarm_idle_ms,
  };
}

export function shouldAutoDisarmSurface(
  config: BridgeConfig,
  surface: RealtimeCallSurfaceRecord,
  now = Date.now(),
): boolean {
  if (!surface.armed) {
    return false;
  }
  if (hasOutstandingLaunchToken(surface, now)) {
    return false;
  }
  return Boolean(surface.expiresAt && surface.expiresAt <= now);
}

export function shouldFailClosedArmingSurface(
  surface: RealtimeCallSurfaceRecord,
  now = Date.now(),
  timeoutMs = 60_000,
): boolean {
  const startedAt = surface.tunnelStartedAt ?? surface.armedAt;
  if (!surface.armed || !startedAt || !hasOutstandingLaunchToken(surface, now)) {
    return false;
  }
  return now - startedAt >= timeoutMs;
}

export function callSurfaceStatusLabel(input: {
  armed: boolean;
  publicReady: boolean;
  activeCall: boolean;
  coolingDown: boolean;
}): RealtimeCallSurfaceStatusLabel {
  if (input.activeCall) {
    return "active";
  }
  if (input.coolingDown) {
    return "cooling-down";
  }
  if (!input.armed) {
    return "disarmed";
  }
  if (!input.publicReady) {
    return "arming";
  }
  return "ready";
}

export function formatSurfaceExpiry(expiresAt: number | null, now = Date.now()): string {
  if (!expiresAt) {
    return "none";
  }
  return `${Math.max(0, Math.ceil((expiresAt - now) / 1000))}s`;
}
