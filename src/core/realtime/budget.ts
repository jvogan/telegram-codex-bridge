import type { BridgeConfig } from "../config.js";
import type { BridgeState } from "../state.js";

export interface RealtimeBudgetSnapshot {
  callsToday: number;
  usedMs: number;
  remainingMs: number;
  perCallCapMs: number;
  nextCallCapMs: number;
  dailyCapMs: number;
}

export function getRealtimeBudgetSnapshot(
  config: BridgeConfig,
  state: BridgeState,
  timestamp = Date.now(),
): RealtimeBudgetSnapshot {
  const usage = state.getRealtimeUsage(timestamp);
  const dailyCapMs = config.realtime.max_daily_call_ms;
  const perCallCapMs = config.realtime.max_call_ms;
  const remainingMs = Math.max(0, dailyCapMs - usage.totalCallMs);
  return {
    callsToday: usage.callCount,
    usedMs: usage.totalCallMs,
    remainingMs,
    perCallCapMs,
    nextCallCapMs: Math.min(perCallCapMs, remainingMs),
    dailyCapMs,
  };
}

export function formatRealtimeBudgetSeconds(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

export function describeRealtimeBudget(snapshot: RealtimeBudgetSnapshot): string {
  return [
    `${snapshot.callsToday} calls today`,
    `${formatRealtimeBudgetSeconds(snapshot.usedMs)} used`,
    `${formatRealtimeBudgetSeconds(snapshot.remainingMs)} remaining`,
    `next call capped at ${formatRealtimeBudgetSeconds(snapshot.nextCallCapMs)}`,
  ].join(" | ");
}
