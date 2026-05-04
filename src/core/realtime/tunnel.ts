import { spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { readFile, truncate } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { BridgeConfig } from "../config.js";
import type { RealtimeCallSurfaceRecord } from "../types.js";
import type { Logger } from "../logger.js";
import { ensureDir, ensurePrivateFile } from "../util/files.js";
import { isProcessRunning, readPidFile, removePidFile, writePidFile } from "../util/pid.js";
import { findRunningProcessByPattern, getRunningProcess, killProcessGracefully } from "../util/process.js";

const QUICK_TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.trycloudflare\.com/ig;
const MAX_ORPHANED_TUNNEL_CLEANUP = 5;
const MAX_CLOUDFLARED_FAILURE_LINES = 4;

export interface ManagedTunnelHandle {
  pid: number;
  url: string;
  startedAt: number;
}

export function tunnelPidPath(config: BridgeConfig): string {
  return join(config.storageRoot, "realtime-tunnel.pid");
}

export function tunnelLogPath(config: BridgeConfig): string {
  return join(config.storageRoot, "realtime-tunnel.log");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function managedQuickTunnelProcessPattern(config: BridgeConfig): RegExp {
  const expectedUrl = `http://${config.realtime.gateway_host}:${config.realtime.gateway_port}`;
  return new RegExp(`\\bcloudflared\\b[\\s\\S]*\\btunnel\\b[\\s\\S]*--url[\\s\\S]*${escapeRegExp(expectedUrl)}`, "i");
}

async function cleanupOrphanedManagedTunnels(config: BridgeConfig, keepPid?: number | null): Promise<number[]> {
  const removed: number[] = [];
  for (let attempt = 0; attempt < MAX_ORPHANED_TUNNEL_CLEANUP; attempt += 1) {
    const found = await findRunningProcessByPattern(managedQuickTunnelProcessPattern(config), {
      cwd: config.repoRoot,
    }).catch(() => null);
    if (!found) {
      break;
    }
    if (keepPid && found.pid === keepPid) {
      break;
    }
    await killProcessGracefully(found.pid).catch(() => undefined);
    removed.push(found.pid);
  }
  return removed;
}

export async function resolveManagedTunnelPid(config: BridgeConfig): Promise<number | null> {
  const pid = await readPidFile(tunnelPidPath(config));
  if (!pid || !isProcessRunning(pid)) {
    await removePidFile(tunnelPidPath(config), pid ?? undefined).catch(() => undefined);
    return null;
  }
  const processInfo = await getRunningProcess(pid);
  const expectedUrl = `http://${config.realtime.gateway_host}:${config.realtime.gateway_port}`;
  const looksManagedTunnel = Boolean(
    processInfo
      && /\bcloudflared\b/i.test(processInfo.command)
      && /\btunnel\b/i.test(processInfo.command)
      && processInfo.command.includes(expectedUrl),
  );
  if (!looksManagedTunnel) {
    await removePidFile(tunnelPidPath(config), pid).catch(() => undefined);
    return null;
  }
  return pid;
}

export async function readManagedQuickTunnelUrl(config: BridgeConfig): Promise<string | null> {
  if (!existsSync(tunnelLogPath(config))) {
    return null;
  }
  const contents = await readFile(tunnelLogPath(config), "utf8").catch(() => "");
  const matches = contents.match(QUICK_TUNNEL_URL_PATTERN);
  if (!matches || matches.length === 0) {
    return null;
  }
  return matches[matches.length - 1] ?? null;
}

async function waitForQuickTunnelUrl(config: BridgeConfig, pid: number, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      const detail = await summarizeCloudflaredFailure(config);
      throw new Error(detail
        ? `cloudflared exited before issuing a public URL: ${detail}`
        : "cloudflared exited before issuing a public URL.");
    }
    const url = await readManagedQuickTunnelUrl(config);
    if (url) {
      return url.replace(/\/$/, "");
    }
    await sleep(250);
  }
  throw new Error("Timed out waiting for cloudflared to issue a quick tunnel URL.");
}

export async function summarizeCloudflaredFailure(config: BridgeConfig): Promise<string | null> {
  const contents = await readFile(tunnelLogPath(config), "utf8").catch(() => "");
  const lines = contents
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => /(?:\b(?:ERR|WRN|error|failed|1015)\b|Too Many Requests|status_code="429")/i.test(line));
  const tail = lines.slice(-MAX_CLOUDFLARED_FAILURE_LINES);
  if (tail.length === 0) {
    return null;
  }
  return tail.join(" | ").replace(/\s+/g, " ").slice(0, 800);
}

export async function stopManagedTunnel(config: BridgeConfig): Promise<number | null> {
  const pid = await resolveManagedTunnelPid(config);
  if (!pid) {
    await removePidFile(tunnelPidPath(config)).catch(() => undefined);
    return null;
  }
  await killProcessGracefully(pid).catch(() => undefined);
  await removePidFile(tunnelPidPath(config), pid).catch(() => undefined);
  return pid;
}

export async function ensureManagedTunnelStopped(config: BridgeConfig): Promise<void> {
  await stopManagedTunnel(config).catch(() => undefined);
}

export async function startManagedQuickTunnel(
  config: BridgeConfig,
  logger: Logger,
  currentSurface?: RealtimeCallSurfaceRecord | null,
): Promise<ManagedTunnelHandle> {
  const existingPid = await resolveManagedTunnelPid(config);
  const existingUrl = currentSurface?.tunnelUrl?.replace(/\/$/, "") ?? await readManagedQuickTunnelUrl(config);
  if (existingPid && existingUrl) {
    return {
      pid: existingPid,
      url: existingUrl,
      startedAt: currentSurface?.tunnelStartedAt ?? Date.now(),
    };
  }
  if (existingPid) {
    await stopManagedTunnel(config);
  }
  const cleanedOrphans = await cleanupOrphanedManagedTunnels(config);
  if (cleanedOrphans.length > 0) {
    logger.warn("cleaned orphaned managed realtime quick tunnels before starting a new one", {
      pids: cleanedOrphans,
    });
  }

  ensureDir(config.storageRoot);
  await truncate(tunnelLogPath(config), 0).catch(() => undefined);
  const logFd = openSync(tunnelLogPath(config), "a", 0o600);
  ensurePrivateFile(tunnelLogPath(config));
  const child = spawn(config.realtime.tunnel_bin, [
    "tunnel",
    "--url",
    `http://${config.realtime.gateway_host}:${config.realtime.gateway_port}`,
    "--no-autoupdate",
  ], {
    cwd: config.repoRoot,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      BRIDGE_CONFIG_PATH: config.configPath,
    },
  });
  child.unref();
  if (!child.pid) {
    throw new Error("Failed to start cloudflared tunnel.");
  }
  await writePidFile(tunnelPidPath(config), child.pid).catch(() => undefined);
  let url: string;
  try {
    url = await waitForQuickTunnelUrl(config, child.pid);
  } catch (error) {
    await killProcessGracefully(child.pid).catch(() => undefined);
    await removePidFile(tunnelPidPath(config), child.pid).catch(() => undefined);
    throw error;
  }
  logger.info("managed realtime quick tunnel ready", {
    pid: child.pid,
    url,
  });
  return {
    pid: child.pid,
    url,
    startedAt: Date.now(),
  };
}
