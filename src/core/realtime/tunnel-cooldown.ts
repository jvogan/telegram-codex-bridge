import type { BridgeState } from "../state.js";

export const MANAGED_TUNNEL_RECOVERY_COOLDOWN_KEY = "realtime:managed_tunnel_recovery_cooldown";
const MANAGED_TUNNEL_PUBLIC_RECOVERY_COOLDOWN_MS = 5 * 60_000;
const MANAGED_TUNNEL_RATE_LIMIT_COOLDOWN_MS = 15 * 60_000;

export interface ManagedTunnelRecoveryCooldown {
  until: number;
  reason: string;
  detail: string;
}

export function cloudflareQuickTunnelRateLimitLikely(message: string): boolean {
  return /\b(?:429|Too Many Requests|1015|rate.?limit)\b/i.test(message);
}

export function managedTunnelRecoveryCooldownDuration(message: string): number {
  return cloudflareQuickTunnelRateLimitLikely(message)
    ? MANAGED_TUNNEL_RATE_LIMIT_COOLDOWN_MS
    : MANAGED_TUNNEL_PUBLIC_RECOVERY_COOLDOWN_MS;
}

export function getManagedTunnelRecoveryCooldown(
  state: BridgeState,
  now = Date.now(),
): ManagedTunnelRecoveryCooldown | null {
  const cooldown = state.getSetting<ManagedTunnelRecoveryCooldown | null>(
    MANAGED_TUNNEL_RECOVERY_COOLDOWN_KEY,
    null,
  );
  if (!cooldown) {
    return null;
  }
  if (cooldown.until <= now) {
    state.setSetting<ManagedTunnelRecoveryCooldown | null>(MANAGED_TUNNEL_RECOVERY_COOLDOWN_KEY, null);
    return null;
  }
  return cooldown;
}

export function setManagedTunnelRecoveryCooldown(
  state: BridgeState,
  reason: string,
  detail: string,
  now = Date.now(),
): ManagedTunnelRecoveryCooldown {
  const cooldown: ManagedTunnelRecoveryCooldown = {
    until: now + managedTunnelRecoveryCooldownDuration(detail),
    reason,
    detail,
  };
  state.setSetting(MANAGED_TUNNEL_RECOVERY_COOLDOWN_KEY, cooldown);
  return cooldown;
}

export function clearManagedTunnelRecoveryCooldown(state: BridgeState): void {
  state.setSetting<ManagedTunnelRecoveryCooldown | null>(MANAGED_TUNNEL_RECOVERY_COOLDOWN_KEY, null);
}

export function managedTunnelRecoveryCooldownDetail(
  cooldown: ManagedTunnelRecoveryCooldown,
  now = Date.now(),
): string {
  const remainingSeconds = Math.max(1, Math.ceil((cooldown.until - now) / 1000));
  return `managed tunnel recovery cooling down for ${remainingSeconds}s after ${cooldown.reason}: ${cooldown.detail}`;
}
