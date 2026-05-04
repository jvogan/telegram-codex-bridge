import type { BridgeConfig } from "../config.js";
import type { RealtimeCallSurfaceRecord } from "../types.js";
import type { ManagedTunnelHandle } from "./tunnel.js";
import { getRealtimeTunnelMode, mintLaunchToken, touchCallSurfaceActivity } from "./surface.js";

export function applyManagedTunnelHandle(
  config: BridgeConfig,
  surface: RealtimeCallSurfaceRecord,
  tunnel: ManagedTunnelHandle,
  options: {
    armedByFallback?: string;
    now?: number;
  } = {},
): RealtimeCallSurfaceRecord {
  const now = options.now ?? Date.now();
  const normalizedUrl = tunnel.url.replace(/\/$/, "");
  const tunnelChanged = tunnel.pid !== surface.tunnelPid
    || normalizedUrl !== (surface.tunnelUrl?.replace(/\/$/, "") ?? null);
  const nextBase: RealtimeCallSurfaceRecord = {
    ...surface,
    tunnelMode: getRealtimeTunnelMode(config),
    tunnelPid: tunnel.pid,
    tunnelUrl: normalizedUrl,
    tunnelStartedAt: tunnel.startedAt,
  };
  if (!surface.armed) {
    return nextBase;
  }
  const active = touchCallSurfaceActivity(config, nextBase, now);
  if (!tunnelChanged) {
    return active;
  }
  return mintLaunchToken(config, active, surface.armedBy ?? options.armedByFallback ?? "bridge", now);
}
