import "dotenv/config";

import { rm } from "node:fs/promises";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { defaultBridgeMode, loadBridgeEnv, loadConfig } from "../core/config.js";
import { ArtifactStore } from "../core/artifacts.js";
import { renderCapabilityLines } from "../core/capabilities.js";
import { RolloutWatcher } from "../core/desktop/rollout-watcher.js";
import { DesktopThreadLocator } from "../core/desktop/thread-locator.js";
import { createLogger } from "../core/logger.js";
import { MediaRegistry } from "../core/media/registry.js";
import {
  describeLiveCallPriorityHint,
  formatAgeSeconds,
  formatTimestamp,
  resolveCallStartResolution,
  summarizeRecentCallSurfaceEvents,
  summarizeRecentCall,
  summarizeRecentFailedTask,
} from "../core/operator-diagnostics.js";
import {
  missingRealtimeControlSecretMessage,
  missingTelegramBotTokenForCallInviteMessage,
} from "../core/onboarding-messages.js";
import { maskIdentifier, redactUrlForLogs } from "../core/redaction.js";
import { formatRealtimeBudgetSeconds, getRealtimeBudgetSnapshot } from "../core/realtime/budget.js";
import { activeCallStatusLabel, callNeedsFinalization, isCallLive } from "../core/realtime/finalization.js";
import {
  describeCallArmBlocker,
  shouldBlockPendingCallHandoffForLiveCall,
} from "../core/realtime/call-enable.js";
import { buildCallInviteText, buildCallLaunchMarkup, buildCallLaunchUrl } from "../core/realtime/invite.js";
import { probeRealtimePublicSurface, type RealtimePublicSurfaceStatus } from "../core/realtime/public-surface.js";
import {
  callSurfaceStatusLabel,
  describeLaunchTokenState,
  describeRememberedDisarmedCallSurface,
  disarmCallSurface as disarmSurfaceRecord,
  formatSurfaceExpiry,
  getRealtimeTunnelMode,
  isLaunchTokenValid,
  mintLaunchToken,
  recordCallSurfaceEvent,
  recordCallSurfaceDisarmReason,
  recordPublicSurfaceProbe,
  touchCallSurfaceActivity,
} from "../core/realtime/surface.js";
import { applyManagedTunnelHandle } from "../core/realtime/tunnel-surface.js";
import {
  clearManagedTunnelRecoveryCooldown,
  getManagedTunnelRecoveryCooldown,
  managedTunnelRecoveryCooldownDetail,
  setManagedTunnelRecoveryCooldown,
} from "../core/realtime/tunnel-cooldown.js";
import {
  ensureManagedTunnelStopped,
  readManagedQuickTunnelUrl,
  resolveManagedTunnelPid,
  startManagedQuickTunnel,
} from "../core/realtime/tunnel.js";
import { BridgeState } from "../core/state.js";
import {
  getTerminalCodexStatus,
  lockTerminalCodexIdentity,
  pingTerminalCodex,
  renderTerminalCodexStatus,
  selectedTerminalBackend,
  sendTerminalCodexControl,
  setTerminalBackendOverride,
  setTerminalCodexIdentity,
  startTerminalCodexAsk,
  startTerminalCodexWorker,
  stopTerminalCodexWorker,
  terminalAttachCommand,
  terminalCodexIdentity,
  waitForTerminalCodexAskCompletion,
} from "../core/terminal/codex-terminal.js";
import { TelegramClient } from "../core/telegram/client.js";
import { deliverAudioArtifacts } from "../core/telegram/audio-delivery.js";
import { deliverDocumentArtifacts } from "../core/telegram/document-delivery.js";
import { deliverImageArtifacts } from "../core/telegram/image-delivery.js";
import { deliverVideoArtifacts } from "../core/telegram/video-delivery.js";
import type {
  BoundThread,
  BridgeMode,
  BridgeOwner,
  RealtimeCallSurfaceEvent,
  RealtimeCallSurfaceRecord,
  ShutdownHintRecord,
  TerminalLaneBackend,
} from "../core/types.js";
import { isProcessRunning, readPidFile, removePidFile, writePidFile } from "../core/util/pid.js";
import { resolveAllowedInspectableFile } from "../core/util/path-policy.js";
import { REALTIME_GATEWAY_PROCESS_PATTERN, TELEGRAM_DAEMON_PROCESS_PATTERN } from "../core/util/process-patterns.js";
import {
  cleanupStaleCodexAppServer,
  findListeningProcess,
  findRunningProcessByPattern,
  getMatchingRunningProcess,
  inspectListeningProcess,
} from "../core/util/process.js";
import {
  cleanupEmptyTimeoutCallArtifacts,
  cleanupStorageRoots,
  rotatePersistentLogFile,
  type StorageCleanupStats,
} from "../core/util/storage-cleanup.js";
import { ensureDir } from "../core/util/files.js";

const entryDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(entryDir, "../..");
process.env.BRIDGE_CONFIG_PATH ??= join(repoRoot, "bridge.config.toml");

const rawArgs = process.argv.slice(2);
if (shouldPrintUsageWithoutConfig(rawArgs)) {
  printUsageAndExit(0);
}

const execFileAsync = promisify(execFile);

const config = loadConfig();
const env = loadBridgeEnv(config);
const state = new BridgeState(config.storageRoot);
const locator = new DesktopThreadLocator();
const logger = createLogger("bridgectl");
const telegram = env.telegramBotToken ? new TelegramClient(env.telegramBotToken, logger) : null;
const registry = new MediaRegistry(config, env, state);
const artifacts = new ArtifactStore(config.storageRoot, state);
const outboundRoot = ensureDir(join(config.storageRoot, "outbound"));
const rolloutWatcher = new RolloutWatcher();

interface DesktopTurnActivity {
  active: boolean;
  turnId: string | null;
  inspectionFailed: boolean;
}

function shouldPrintUsageWithoutConfig(args: string[]): boolean {
  return args.length === 0 || args.includes("help") || args.includes("--help") || args.includes("-h");
}

function usageText(): string {
  return [
    "Usage:",
    "  bridgectl start",
    "  bridgectl stop",
    "  bridgectl shutdown",
    "  bridgectl status",
    "  bridgectl gateway start|stop|status",
    "  bridgectl threads [--cwd /path] [--limit N]",
    "  bridgectl connect [--cwd /path]",
    "  bridgectl claim-current [--cwd /path]",
    "  bridgectl claim <thread_id>",
    "  bridgectl bind-current [--cwd /path] [--owner telegram|desktop|none]",
    "  bridgectl bind <thread_id> [--owner telegram|desktop|none]",
    "  bridgectl detach",
    "  bridgectl mode [autonomous-thread|shared-thread-resume|shadow-window]",
    "  bridgectl owner [telegram|desktop|none]",
    "  bridgectl sleep",
    "  bridgectl wake",
    "  bridgectl capabilities",
    "  bridgectl terminal status|use|init|start|stop|restart|lock|unlock|ping|ask|interrupt|clear|unlock-superpowers",
    "  bridgectl call arm|start|invite [message...]|disarm|hangup|status",
    "  bridgectl send <path> [--caption text]",
    "  bridgectl cleanup [--days N] [--purge-delivered-artifacts]",
    "  bridgectl inbox",
    "  bridgectl recover-queue [--force]",
    "  bridgectl watch [--seconds N] [--interval-ms N] [--limit N]",
  ].join("\n");
}

function printUsageAndExit(code: number): never {
  const stream = code === 0 ? process.stdout : process.stderr;
  stream.write(`${usageText()}\n`);
  process.exit(code);
}

async function currentDesktopTurnActivity(): Promise<DesktopTurnActivity> {
  const binding = state.getBoundThread();
  if (!binding?.rolloutPath || state.getMode(defaultBridgeMode(config)) !== "shared-thread-resume") {
    return { active: false, turnId: null, inspectionFailed: false };
  }
  try {
    const activity = await rolloutWatcher.getThreadActivity(binding.rolloutPath);
    return {
      active: Boolean(activity.activeTurnId),
      turnId: activity.activeTurnId,
      inspectionFailed: false,
    };
  } catch (error) {
    logger.warn("failed to inspect shared-thread rollout activity", {
      rolloutPath: binding.rolloutPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return { active: true, turnId: null, inspectionFailed: true };
  }
}

function usage(): never {
  throw new Error(usageText());
}

function getMode(): BridgeMode {
  return state.getMode(defaultBridgeMode(config));
}

function getOwner(): BridgeOwner {
  return state.getOwner("none");
}

function getActiveCall() {
  return state.getActiveCall();
}

function getCallSurface(): RealtimeCallSurfaceRecord {
  return state.getCallSurface(getRealtimeTunnelMode(config));
}

function setCallSurface(surface: RealtimeCallSurfaceRecord): void {
  state.setCallSurface({
    ...surface,
    tunnelMode: getRealtimeTunnelMode(config),
  });
}

function rememberCallSurfaceEvent(
  event: Omit<RealtimeCallSurfaceEvent, "at"> & { at?: number },
  surface = getCallSurface(),
): RealtimeCallSurfaceRecord {
  const next = recordCallSurfaceEvent(surface, {
    ...event,
    at: event.at ?? Date.now(),
  });
  setCallSurface(next);
  return next;
}

async function syncManagedTunnelState(surface = getCallSurface()): Promise<RealtimeCallSurfaceRecord> {
  if (surface.tunnelMode !== "managed-quick-cloudflared") {
    return surface;
  }
  const tunnelPid = await resolveManagedTunnelPid(config);
  const observedUrl = tunnelPid ? await readManagedQuickTunnelUrl(config).catch(() => null) : null;
  const nextUrl = tunnelPid
    ? tunnelPid === surface.tunnelPid
      ? observedUrl ?? surface.tunnelUrl
      : observedUrl
    : null;
  const nextStartedAt = tunnelPid
    ? tunnelPid === surface.tunnelPid
      ? surface.tunnelStartedAt
      : observedUrl
        ? Date.now()
        : null
    : null;
  if (tunnelPid === surface.tunnelPid && nextUrl === surface.tunnelUrl && nextStartedAt === surface.tunnelStartedAt) {
    return surface;
  }
  const next: RealtimeCallSurfaceRecord = {
    ...surface,
    tunnelPid,
    tunnelUrl: nextUrl,
    tunnelStartedAt: nextStartedAt,
  };
  setCallSurface(next);
  return next;
}

async function disarmCallSurfaceLifecycle(reason: string): Promise<RealtimeCallSurfaceRecord> {
  const current = await syncManagedTunnelState();
  if (current.tunnelMode === "managed-quick-cloudflared") {
    await ensureManagedTunnelStopped(config);
  }
  const next = rememberCallSurfaceEvent({
    action: "disarm",
    outcome: "ok",
    source: "bridge lifecycle",
    detail: reason,
  }, recordCallSurfaceDisarmReason(disarmSurfaceRecord(current), reason));
  return next;
}

async function disarmManagedCallSurface(reason: string): Promise<RealtimeCallSurfaceRecord> {
  const surface = await disarmCallSurfaceLifecycle(reason);
  logger.info("call surface disarmed", { reason });
  return surface;
}

async function preparePersistentLog(path: string, label: string): Promise<void> {
  const rotated = await rotatePersistentLogFile(path).catch(error => {
    logger.warn("failed to rotate persistent log", {
      label,
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
  if (rotated) {
    logger.warn("rotated persistent log before startup", {
      label,
      path,
      archivedPath: rotated.archivedPath,
      bytes: rotated.bytes,
    });
  }
}

async function armCallSurface(armedBy: string): Promise<{
  surface: RealtimeCallSurfaceRecord;
  publicSurface: Awaited<ReturnType<typeof probeRealtimePublicSurface>>;
}> {
  if (!config.realtime.enabled) {
    throw new Error("Realtime is disabled in bridge.config.toml.");
  }
  await ensureCallSurfaceCanArm();
  const daemonPid = await resolveDaemonPid();
  if (!daemonPid) {
    const daemonIssue = await describeDaemonIssue(daemonPid);
    throw new Error(
      daemonIssue
        ? `telegram-daemon must be running before the live call surface can be armed. ${daemonIssue}.`
        : "telegram-daemon must be running before the live call surface can be armed.",
    );
  }
  if (!await fetchOk(`http://127.0.0.1:${config.codex.app_server_port}/readyz`)) {
    throw new Error("telegram-daemon is not ready yet.");
  }
  const gateway = await startGatewayIfNeeded();
  await waitForRealtimeGatewayBridgeReady();
  const gatewayReady = await fetchOk(gatewayReadyUrl());
  const gatewayBridgeReady = await effectiveGatewayBridgeReady(gatewayReady, await resolveDaemonPid());
  await ensureCallSurfaceCanArm({
    gatewayReady,
    gatewayConnected: gatewayBridgeReady,
  });
  let surface: RealtimeCallSurfaceRecord = {
    ...getCallSurface(),
    armed: true,
    armedAt: Date.now(),
    armedBy,
    tunnelMode: getRealtimeTunnelMode(config),
  };
  const priorTunnelPid = surface.tunnelPid;
  if (surface.tunnelMode === "managed-quick-cloudflared") {
    const cooldown = getManagedTunnelRecoveryCooldown(state);
    if (cooldown) {
      throw new Error(managedTunnelRecoveryCooldownDetail(cooldown));
    }
    const tunnel = await startManagedQuickTunnel(config, logger, surface).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      setManagedTunnelRecoveryCooldown(state, "bridgectl call arm", message);
      throw error;
    });
    clearManagedTunnelRecoveryCooldown(state);
    surface = applyManagedTunnelHandle(config, surface, tunnel, {
      armedByFallback: armedBy,
    });
  } else {
    surface = {
      ...surface,
      tunnelPid: null,
      tunnelUrl: config.realtime.public_url ? config.realtime.public_url.replace(/\/$/, "") : null,
      tunnelStartedAt: null,
    };
  }
  try {
    const currentGatewayReady = await fetchOk(gatewayReadyUrl());
    const currentGatewayBridgeReady = await effectiveGatewayBridgeReady(currentGatewayReady, await resolveDaemonPid());
    await ensureCallSurfaceCanArm({
      gatewayReady: currentGatewayReady,
      gatewayConnected: currentGatewayBridgeReady,
    });
  } catch (error) {
    if (surface.tunnelMode === "managed-quick-cloudflared" && surface.tunnelPid && surface.tunnelPid !== priorTunnelPid) {
      await ensureManagedTunnelStopped(config).catch(() => undefined);
    }
    throw error;
  }
  surface = mintLaunchToken(config, touchCallSurfaceActivity(config, surface), armedBy);
  setCallSurface(surface);
  const publicSurface = await probePublicSurfaceWithWarmup(surface);
  surface = recordPublicSurfaceProbe(surface, publicSurface);
  surface = rememberCallSurfaceEvent({
    action: "arm",
    outcome: "ok",
    source: armedBy,
    detail: publicSurface.ready
      ? "live-call surface armed and the public Mini App is reachable"
      : `live-call surface armed; public Mini App still warming (${publicSurface.detail})`,
  }, surface);
  if (gateway.started && gateway.pid) {
    console.log(`started realtime-gateway (pid ${gateway.pid})`);
  } else if (gateway.pid) {
    console.log(`using existing realtime-gateway (pid ${gateway.pid})`);
  }
  return { surface, publicSurface };
}

function refreshLaunchToken(surface: RealtimeCallSurfaceRecord, armedBy: string): RealtimeCallSurfaceRecord {
  if (!surface.armed) {
    throw new Error("Call surface is disarmed. Run `bridgectl call arm` or send `/call enable` first.");
  }
  const now = Date.now();
  const next = mintLaunchToken(config, surface, armedBy, now);
  setCallSurface(next);
  return next;
}

function currentRealtimeBudget() {
  return getRealtimeBudgetSnapshot(config, state);
}

function currentCallBudgetCapMs(): number {
  return currentRealtimeBudget().nextCallCapMs;
}

function currentCallSurfaceLabel(
  surface: RealtimeCallSurfaceRecord,
  publicReady: boolean,
  activeCall = getActiveCall(),
): string {
  return callSurfaceStatusLabel({
    armed: surface.armed,
    publicReady,
    activeCall: Boolean(isCallLive(activeCall)),
    coolingDown: Boolean(surface.armed && !isCallLive(activeCall) && !surface.launchTokenId && surface.expiresAt && surface.expiresAt > Date.now()),
  });
}

function summarizePublicCallIssue(input: {
  surface: RealtimeCallSurfaceRecord;
  gatewayReady: boolean;
  gatewayBridgeReady: boolean;
  publicSurfaceReady: boolean;
  publicSurfaceDetail: string;
  daemonIssue?: string | null;
}): string {
  if (input.daemonIssue) {
    return input.daemonIssue;
  }
  if (!input.surface.armed) {
    return describeRememberedDisarmedCallSurface(input.surface) ?? "call surface is disarmed";
  }
  if (!input.gatewayReady) {
    return "realtime gateway is not healthy";
  }
  if (!input.gatewayBridgeReady) {
    return "gateway is healthy, but the local bridge control channel is not connected";
  }
  if (!input.publicSurfaceReady) {
    return input.publicSurfaceDetail;
  }
  return "none";
}

async function describeDaemonIssue(pid: number | null): Promise<string | null> {
  if (pid) {
    if (await fetchOk(`http://127.0.0.1:${config.codex.app_server_port}/readyz`)) {
      return null;
    }
    return `telegram-daemon is running, but the local Codex app-server on port ${config.codex.app_server_port} is not ready`;
  }
  const listener = await inspectListeningProcess(config.codex.app_server_port).catch(() => null);
  if (!listener) {
    return null;
  }
  const cwd = listener.cwd ? ` from ${listener.cwd}` : "";
  return `port ${config.codex.app_server_port} is occupied by ${listener.command} (pid ${listener.pid})${cwd}`;
}

interface CallStartBlocker {
  summary: string;
  nextStep: string;
}

function describeDesktopTurnInteractiveBlocker(activity: DesktopTurnActivity): CallStartBlocker | null {
  if (!activity.active) {
    return null;
  }
  if (activity.inspectionFailed) {
    return {
      summary: "The bound desktop Codex session activity could not be read safely, so the bridge is treating it as busy.",
      nextStep: "Wait for the current desktop turn to finish or repair the rollout file, then retry /call.",
    };
  }
  return {
    summary: `The bound desktop Codex session is already executing another turn (${activity.turnId ?? "(unknown turn)"}).`,
    nextStep: "Wait for the current desktop turn to finish, then retry /call.",
  };
}

function launchTokenReadyForCurrentBridge(surface: RealtimeCallSurfaceRecord): boolean {
  return !surface.launchTokenTelegramChatInstance && isLaunchTokenValid(surface, surface.launchTokenId, {
    bridgeId: config.realtime.bridge_id,
    telegramUserId: config.telegram.authorized_chat_id,
  });
}

function describeCallStartBlocker(input: {
  surface: RealtimeCallSurfaceRecord;
  activeCall?: ReturnType<typeof getActiveCall>;
  gatewayReady?: boolean;
  gatewayBridgeReady?: boolean;
  publicSurface?: RealtimePublicSurfaceStatus;
}): CallStartBlocker | null {
  if (!config.realtime.enabled) {
    return {
      summary: "Realtime calling is disabled in bridge.config.toml.",
      nextStep: "Enable realtime calling before retrying /call.",
    };
  }
  if (input.gatewayReady === false) {
    return {
      summary: "The realtime gateway is not healthy.",
      nextStep: "Repair or restart the gateway, then retry /call.",
    };
  }
  if (input.gatewayBridgeReady === false) {
    return {
      summary: "The realtime gateway control channel is not connected.",
      nextStep: "Reconnect the gateway control channel, then retry /call.",
    };
  }
  if (!input.surface.armed) {
    return {
      summary: "Live calling is disarmed.",
      nextStep: "Run `bridgectl call arm` or send `/call enable`, then retry /call.",
    };
  }
  if (input.publicSurface && !input.publicSurface.ready) {
    return {
      summary: `The public Mini App is not reachable (${input.publicSurface.detail}).`,
      nextStep: "Fix the public live-call surface, then retry /call.",
    };
  }
  const activeCall = input.activeCall ?? getActiveCall();
  if (callNeedsFinalization(activeCall)) {
    return {
      summary: isCallLive(activeCall)
        ? `A live call is already active (${activeCall?.callId ?? "(unknown call)"}).`
        : `A previous live call is still being finalized (${activeCall?.callId ?? "(unknown call)"}).`,
      nextStep: "Wait for the live call to clear, then retry /call.",
    };
  }
  const pendingApprovals = state.getPendingApprovalCount();
  if (pendingApprovals > 0) {
    return {
      summary: `There ${pendingApprovals === 1 ? "is" : "are"} ${pendingApprovals} pending approval${pendingApprovals === 1 ? "" : "s"}.`,
      nextStep: "Resolve the approvals first, then retry /call.",
    };
  }
  const pendingCallHandoffs = state.getPendingCallHandoffCount();
  if (pendingCallHandoffs > 0) {
    return {
      summary: "A previous call handoff is still waiting to be appended into Codex.",
      nextStep: "Let the handoff flush first, then retry /call.",
    };
  }
  if (getOwner() !== "telegram") {
    return {
      summary: `The session owner is ${getOwner()}, not telegram.`,
      nextStep: "Switch ownership back to telegram, then retry /call.",
    };
  }
  if (!state.getBoundThread()) {
    return {
      summary: "No desktop Codex thread is attached.",
      nextStep: "Attach a desktop Codex thread, then retry /call.",
    };
  }
  return null;
}

async function probePublicSurfaceWithWarmup(
  surface: RealtimeCallSurfaceRecord,
  attempts = 20,
  delayMs = 1_000,
) {
  let result = await probeRealtimePublicSurface(config, surface, publicSurfaceProbeOptions());
  for (let attempt = 1; attempt < attempts && !result.ready; attempt += 1) {
    const detail = result.detail.toLowerCase();
    const transient = detail.includes("dns lookup failed")
      || detail.includes("unreachable")
      || detail.includes("timed out")
      || detail.includes("returned http 5");
    if (!transient) {
      break;
    }
    await sleep(delayMs);
    result = await probeRealtimePublicSurface(config, surface, publicSurfaceProbeOptions());
  }
  return result;
}

function pidPath(): string {
  return join(config.storageRoot, "telegram-daemon.pid");
}

function gatewayPidPath(): string {
  return join(config.storageRoot, "realtime-gateway.pid");
}

async function resolveDaemonPid(): Promise<number | null> {
  const recordedPid = await readPidFile(pidPath());
  if (
    recordedPid
    && await getMatchingRunningProcess(recordedPid, TELEGRAM_DAEMON_PROCESS_PATTERN, { cwd: config.repoRoot }).catch(() => null)
  ) {
    return recordedPid;
  }
  if (recordedPid) {
    await removePidFile(pidPath(), recordedPid).catch(() => undefined);
  }
  const discovered = await findRunningProcessByPattern(TELEGRAM_DAEMON_PROCESS_PATTERN, {
    excludePid: process.pid,
    cwd: config.repoRoot,
  }).catch(() => null);
  if (!discovered || !isProcessRunning(discovered.pid)) {
    return null;
  }
  await writePidFile(pidPath(), discovered.pid).catch(() => undefined);
  return discovered.pid;
}

async function resolveGatewayPid(): Promise<number | null> {
  const recordedPid = await readPidFile(gatewayPidPath());
  if (
    recordedPid
    && await getMatchingRunningProcess(recordedPid, REALTIME_GATEWAY_PROCESS_PATTERN, { cwd: config.repoRoot }).catch(() => null)
  ) {
    return recordedPid;
  }
  if (recordedPid) {
    await removePidFile(gatewayPidPath(), recordedPid).catch(() => undefined);
  }
  const discovered = await findRunningProcessByPattern(REALTIME_GATEWAY_PROCESS_PATTERN, {
    excludePid: process.pid,
    cwd: config.repoRoot,
  }).catch(() => null);
  if (!discovered || !isProcessRunning(discovered.pid)) {
    const listener = await findListeningProcess(config.realtime.gateway_port).catch(() => null);
    if (!listener || !isProcessRunning(listener.pid)) {
      return null;
    }
    try {
      const response = await fetch(gatewayReadyUrl());
      if (!response.ok) {
        return null;
      }
    } catch {
      return null;
    }
    await writePidFile(gatewayPidPath(), listener.pid).catch(() => undefined);
    return listener.pid;
  }
  await writePidFile(gatewayPidPath(), discovered.pid).catch(() => undefined);
  return discovered.pid;
}

function gatewayReadyUrl(): string {
  return `http://${config.realtime.gateway_host}:${config.realtime.gateway_port}/healthz`;
}

function gatewayDetailsUrl(): string {
  return `http://${config.realtime.gateway_host}:${config.realtime.gateway_port}/healthz/details`;
}

function gatewayAuthHeaders(): Record<string, string> {
  return env.realtimeControlSecret
    ? { "x-bridge-secret": env.realtimeControlSecret }
    : {};
}

function publicSurfaceProbeOptions(timeoutMs?: number): Parameters<typeof probeRealtimePublicSurface>[2] {
  return {
    ...(timeoutMs ? { timeoutMs } : {}),
    extraHeaders: gatewayAuthHeaders(),
    preferControlMiniAppProbe: Boolean(env.realtimeControlSecret),
  };
}

async function processStartedAt(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 1_000,
    });
    const raw = stdout.trim();
    if (!raw) {
      return null;
    }
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function fetchOk(url: string, timeoutMs = 750): Promise<boolean> {
  try {
    const response = await fetch(url, {
      headers: gatewayAuthHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function gatewayBridgeConnected(timeoutMs = 750): Promise<boolean> {
  if (!env.realtimeControlSecret) {
    return false;
  }
  try {
    const response = await fetch(gatewayDetailsUrl(), {
      headers: gatewayAuthHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return false;
    }
    const payload = await response.json() as {
      bridges?: Array<{
        bridgeId?: string | null;
      }>;
    };
    return Boolean(payload.bridges?.some(bridge => bridge.bridgeId === config.realtime.bridge_id));
  } catch {
    return false;
  }
}

async function effectiveGatewayBridgeReady(gatewayReady: boolean, daemonPid: number | null): Promise<boolean> {
  if (!gatewayReady) {
    return false;
  }
  if (await gatewayBridgeConnected()) {
    return true;
  }
  if (!daemonPid || !isProcessRunning(daemonPid)) {
    return false;
  }
  const persisted = state.getGatewayBridgeConnection();
  if (!persisted?.connected) {
    return false;
  }
  return Date.now() - persisted.updatedAt <= 5 * 60_000;
}

function recordShutdownHint(hint: Omit<ShutdownHintRecord, "requestedAt">): void {
  state.setShutdownHint({
    ...hint,
    requestedAt: Date.now(),
  });
}

async function waitForGatewayReady(expectedPid: number | null, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = gatewayReadyUrl();
  while (Date.now() < deadline) {
    if (expectedPid && !isProcessRunning(expectedPid)) {
      throw new Error(`realtime-gateway pid ${expectedPid} exited before the gateway became ready.`);
    }
    const currentPid = await readPidFile(gatewayPidPath());
    if (expectedPid && currentPid !== expectedPid) {
      await sleep(250);
      continue;
    }
    if (await fetchOk(url)) {
      return;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for gateway readiness at ${url}.`);
}

async function startGatewayIfNeeded(): Promise<{ pid: number | null; started: boolean }> {
  if (!config.realtime.enabled) {
    return { pid: null, started: false };
  }
  const pid = await resolveGatewayPid();
  if (pid) {
    if (await fetchOk(gatewayReadyUrl())) {
      return { pid, started: false };
    }
    await stopGatewayIfRunning().catch(error => {
      throw new Error(
        `Realtime gateway pid ${pid} exists but is not healthy, and cleanup failed. ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }
  const listener = await findListeningProcess(config.realtime.gateway_port).catch(() => null);
  if (listener) {
    throw new Error(
      `Realtime gateway port ${config.realtime.gateway_port} is already in use by ${listener.command} (pid ${listener.pid}).`,
    );
  }
  const gatewayPath = join(config.repoRoot, "dist", "bin", "realtime-gateway.js");
  if (!existsSync(gatewayPath)) {
    throw new Error(`Built gateway not found at ${gatewayPath}. Run npm run build first.`);
  }
  mkdirSync(config.storageRoot, { recursive: true });
  const logPath = join(config.storageRoot, "realtime-gateway.log");
  await preparePersistentLog(logPath, "realtime-gateway");
  const logFd = openSync(logPath, "a");
  const child = spawn(process.execPath, [gatewayPath], {
    cwd: config.repoRoot,
    env: {
      ...process.env,
      BRIDGE_CONFIG_PATH: config.configPath,
    },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  await writePidFile(gatewayPidPath(), child.pid ?? undefined).catch(() => undefined);
  try {
    await waitForGatewayReady(child.pid ?? null);
  } catch (error) {
    if (child.pid && isProcessRunning(child.pid)) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        // Ignore cleanup failures here; readiness error is more useful.
      }
    }
    throw error;
  }
  return { pid: child.pid ?? null, started: true };
}

async function commandStart(): Promise<void> {
  const pid = await resolveDaemonPid();
  if (pid) {
    throw new Error(`telegram-daemon is already running with pid ${pid}`);
  }
  const recoveredBeforeStart = recoverQueueForControl({ reason: "bridgectl start" });
  if (recoveredBeforeStart.changed > 0) {
    console.log(formatQueueRecoverySummary(recoveredBeforeStart));
  }
  const gateway = await startGatewayIfNeeded();
  try {
    if (await isPortListening(config.codex.app_server_port)) {
      const cleaned = await cleanupStaleCodexAppServer(config.codex.app_server_port, {
        cwd: config.repoRoot,
      }).catch(error => {
        throw new Error(
          `Port ${config.codex.app_server_port} is already in use before startup. ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
      if (cleaned) {
        console.log(`cleaned stale ${cleaned.command} process ${cleaned.pid} from port ${config.codex.app_server_port}`);
      }
      if (await isPortListening(config.codex.app_server_port)) {
        try {
          await waitForPortClosed(config.codex.app_server_port, 5_000);
        } catch {
          throw new Error(
            `Port ${config.codex.app_server_port} is still in use after stale-process cleanup. `
            + "Wait a moment and retry.",
          );
        }
      }
    }
    const daemonPath = join(config.repoRoot, "dist", "bin", "telegram-daemon.js");
    if (!existsSync(daemonPath)) {
      throw new Error(`Built daemon not found at ${daemonPath}. Run npm run build first.`);
    }
    mkdirSync(config.storageRoot, { recursive: true });
    const logPath = join(config.storageRoot, "telegram-daemon.log");
    await preparePersistentLog(logPath, "telegram-daemon");
    const logFd = openSync(logPath, "a");
    const child = spawn(process.execPath, [daemonPath], {
      cwd: config.repoRoot,
      env: {
        ...process.env,
        BRIDGE_CONFIG_PATH: config.configPath,
      },
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    await waitForBridgeReady(child.pid ?? null);
    if (gateway.started && gateway.pid) {
      console.log(`started realtime-gateway (pid ${gateway.pid})`);
    } else if (gateway.pid) {
      console.log(`using existing realtime-gateway (pid ${gateway.pid})`);
    }
    console.log(`started telegram-daemon (pid ${child.pid ?? "unknown"})`);
  } catch (error) {
    if (gateway.started) {
      await stopGatewayIfRunning().catch(() => undefined);
    }
    throw error;
  }
}

function hasForceFlag(args: string[]): boolean {
  return args.includes("--force");
}

async function commandStop(args: string[]): Promise<void> {
  const force = hasForceFlag(args);
  if (!force) {
    const reason = await unsafeMutationReason();
    if (reason) {
      throw new Error(`${reason} Refusing to stop the Telegram bridge without --force.`);
    }
  }
  recordShutdownHint({
    source: "signal",
    initiatedBy: "bridgectl stop",
    details: {
      force,
      cwd: process.cwd(),
    },
  });
  const pid = await stopDaemonIfRunning({ forceKillAfterTimeout: force });
  const gatewayPid = await stopGatewayIfRunning();
  await disarmManagedCallSurface("bridgectl stop").catch(() => undefined);
  if (!pid && !gatewayPid) {
    state.setShutdownHint(null);
    console.log("telegram-daemon and realtime-gateway are not running");
    return;
  }
  if (pid) {
    console.log(`sent SIGTERM to telegram-daemon pid ${pid}`);
  }
  if (gatewayPid) {
    console.log(`sent SIGTERM to realtime-gateway pid ${gatewayPid}`);
  }
}

async function commandRecoverQueue(args: string[]): Promise<void> {
  const force = hasForceFlag(args);
  const active = state.getActiveTask();
  const pid = await resolveDaemonPid();

  if (active && pid && !force) {
    throw new Error(
      `Active Telegram task ${active.queueId} is recorded while telegram-daemon pid ${pid} is running. `
      + "Use `bridgectl recover-queue --force` to stop the daemon, fail-closed or requeue the task, and restart cleanly.",
    );
  }

  let stoppedPid: number | null = null;
  if (active && pid && force) {
    recordShutdownHint({
      source: "signal",
      initiatedBy: "bridgectl recover-queue",
      details: {
        activeTask: active.queueId,
        force: true,
        cwd: process.cwd(),
      },
    });
    stoppedPid = await stopDaemonIfRunning({ forceKillAfterTimeout: true });
  }

  const result = recoverQueueForControl({
    reason: "bridgectl recover-queue",
    forceActive: force || !pid,
  });

  if (stoppedPid) {
    await commandStart();
  }

  if (result.changed === 0) {
    console.log("queue recovery: no processing tasks needed recovery");
    return;
  }
  console.log(formatQueueRecoverySummary(result));
}

async function stopDaemonIfRunning(options: { forceKillAfterTimeout?: boolean } = {}): Promise<number | null> {
  const pid = await resolveDaemonPid();
  if (!pid) {
    return null;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ESRCH")) {
      throw error;
    }
    state.setShutdownHint(null);
    await removePidFile(pidPath(), pid).catch(() => undefined);
    await waitForPortClosed(config.codex.app_server_port).catch(() => undefined);
    return pid;
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      await removePidFile(pidPath(), pid).catch(() => undefined);
      if (await isPortListening(config.codex.app_server_port)) {
        const cleaned = await cleanupStaleCodexAppServer(config.codex.app_server_port, {
          cwd: config.repoRoot,
        }).catch(() => null);
        if (cleaned) {
          await waitForPortClosed(config.codex.app_server_port).catch(() => undefined);
        }
      }
      await waitForPortClosed(config.codex.app_server_port).catch(() => undefined);
      return pid;
    }
    await sleep(250);
  }
  if (!options.forceKillAfterTimeout) {
    throw new Error(`Timed out waiting for telegram-daemon pid ${pid} to exit.`);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ESRCH")) {
      throw error;
    }
  }
  const killDeadline = Date.now() + 5_000;
  while (Date.now() < killDeadline) {
    if (!isProcessRunning(pid)) {
      await removePidFile(pidPath(), pid).catch(() => undefined);
      if (await isPortListening(config.codex.app_server_port)) {
        const cleaned = await cleanupStaleCodexAppServer(config.codex.app_server_port, {
          cwd: config.repoRoot,
        }).catch(() => null);
        if (cleaned) {
          await waitForPortClosed(config.codex.app_server_port).catch(() => undefined);
        }
      }
      await waitForPortClosed(config.codex.app_server_port).catch(() => undefined);
      return pid;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for telegram-daemon pid ${pid} to exit after SIGKILL.`);
}

async function stopGatewayIfRunning(): Promise<number | null> {
  const pid = await resolveGatewayPid();
  if (!pid) {
    return null;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ESRCH")) {
      throw error;
    }
    await removePidFile(gatewayPidPath(), pid).catch(() => undefined);
    return pid;
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      await removePidFile(gatewayPidPath(), pid).catch(() => undefined);
      return pid;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for realtime-gateway pid ${pid} to exit.`);
}

async function isPortListening(port: number): Promise<boolean> {
  return await new Promise<boolean>(resolvePromise => {
    const socket = new Socket();
    const finish = (value: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolvePromise(value);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, "127.0.0.1");
  });
}

async function waitForPortClosed(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await isPortListening(port)) {
      return;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for port ${port} to close.`);
}

async function waitForBridgeReady(expectedPid: number | null, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${config.codex.app_server_port}/readyz`;
  while (Date.now() < deadline) {
    if (expectedPid && !isProcessRunning(expectedPid)) {
      throw new Error(`telegram-daemon pid ${expectedPid} exited before the bridge became ready.`);
    }
    const currentPid = await readPidFile(pidPath());
    if (expectedPid && currentPid !== expectedPid) {
      await sleep(250);
      continue;
    }
    if (await fetchOk(url)) {
      return;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for bridge readiness at ${url}.`);
}

interface ProcessingQueueRow {
  id: string;
  updated_at: number;
}

interface QueueRecoveryResult {
  reason: string;
  requeued: string[];
  failed: string[];
  clearedActiveTask: boolean;
  skippedActiveTask: string | null;
  changed: number;
}

function processingQueueRows(): ProcessingQueueRow[] {
  return state.db.prepare(`
    SELECT id, updated_at
    FROM message_queue
    WHERE status = 'processing'
    ORDER BY updated_at ASC
  `).all() as unknown as ProcessingQueueRow[];
}

function recoverQueueForControl(options: { reason: string; forceActive?: boolean }): QueueRecoveryResult {
  const rows = processingQueueRows();
  const active = state.getActiveTask();
  const processingIds = new Set(rows.map(row => row.id));
  const result: QueueRecoveryResult = {
    reason: options.reason,
    requeued: [],
    failed: [],
    clearedActiveTask: false,
    skippedActiveTask: null,
    changed: 0,
  };

  for (const row of rows) {
    if (active?.queueId === row.id) {
      if (!options.forceActive) {
        result.skippedActiveTask = row.id;
        continue;
      }
      const replaySafe = active.stage === "preparing";
      state.updateQueueStatus(row.id, replaySafe ? "pending" : "failed", {
        placeholderMessageId: active.placeholderMessageId,
        errorText: replaySafe
          ? null
          : `Recovered stale in-flight task during ${options.reason}; not auto-replayed because it may have already reached Codex.`,
      });
      if (replaySafe) {
        result.requeued.push(row.id);
      } else {
        result.failed.push(row.id);
      }
      result.changed += 1;
      continue;
    }
    state.updateQueueStatus(row.id, "pending", { errorText: null });
    result.requeued.push(row.id);
    result.changed += 1;
  }

  if (active && (!processingIds.has(active.queueId) || options.forceActive)) {
    state.setActiveTask(null);
    result.clearedActiveTask = true;
    result.changed += 1;
  }

  return result;
}

function formatQueueRecoverySummary(result: QueueRecoveryResult): string {
  const parts = [`queue recovery (${result.reason})`];
  if (result.requeued.length > 0) {
    parts.push(`requeued=${result.requeued.length}`);
  }
  if (result.failed.length > 0) {
    parts.push(`failed=${result.failed.length}`);
  }
  if (result.clearedActiveTask) {
    parts.push("clearedActiveTask=true");
  }
  if (result.skippedActiveTask) {
    parts.push(`skippedActiveTask=${result.skippedActiveTask}`);
  }
  return parts.join(" ");
}

async function ensureDaemonStoppedForMutation(): Promise<void> {
  const pid = await resolveDaemonPid();
  if (pid) {
    throw new Error("Stop the running telegram-daemon first, or use Telegram commands for live mode/binding changes.");
  }
}

async function unsafeMutationReason(): Promise<string | null> {
  const activeTask = state.getActiveTask();
  if (activeTask) {
    return "Bridge recovery still has an in-flight Telegram task recorded.";
  }
  const activeCall = getActiveCall();
  if (callNeedsFinalization(activeCall)) {
    return `Live call ${activeCall.callId} is still ${activeCall.status}.`;
  }
  const queuedTasks = state.getQueuedTaskCount();
  if (queuedTasks > 0) {
    return `There ${queuedTasks === 1 ? "is" : "are"} ${queuedTasks} queued Telegram ${queuedTasks === 1 ? "task" : "tasks"}.`;
  }
  const pendingApprovals = state.getPendingApprovalCount();
  if (pendingApprovals > 0) {
    return `There ${pendingApprovals === 1 ? "is" : "are"} ${pendingApprovals} pending approval ${pendingApprovals === 1 ? "request" : "requests"}.`;
  }
  const pendingHandoffs = state.getPendingCallHandoffCount();
  if (pendingHandoffs > 0) {
    return `There ${pendingHandoffs === 1 ? "is" : "are"} ${pendingHandoffs} pending call handoff ${pendingHandoffs === 1 ? "artifact" : "artifacts"} waiting to be appended into Codex.`;
  }
  const desktopTurn = await currentDesktopTurnActivity();
  const desktopTurnBlocker = describeDesktopTurnInteractiveBlocker(desktopTurn);
  if (desktopTurnBlocker) {
    return desktopTurnBlocker.summary;
  }
  return null;
}

function parseOptionalDays(args: string[], fallback: number): number {
  const index = args.indexOf("--days");
  const raw = index >= 0 ? args[index + 1] : undefined;
  if (!raw) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Days must be a non-negative integer.");
  }
  return value;
}

function parseOptionalSeconds(args: string[], fallback: number): number {
  const index = args.indexOf("--seconds");
  const raw = index >= 0 ? args[index + 1] : undefined;
  if (!raw) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Seconds must be a non-negative integer.");
  }
  return value;
}

function parseOptionalIntervalMs(args: string[], fallback: number): number {
  const index = args.indexOf("--interval-ms");
  const raw = index >= 0 ? args[index + 1] : undefined;
  if (!raw) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 100) {
    throw new Error("Interval must be an integer number of milliseconds greater than or equal to 100.");
  }
  return value;
}

function shouldPurgeDeliveredArtifacts(args: string[]): boolean {
  return args.includes("--purge-delivered-artifacts");
}

function mergeCleanupStats(target: StorageCleanupStats, next: StorageCleanupStats): void {
  target.scannedEntries += next.scannedEntries;
  target.removedFiles += next.removedFiles;
  target.removedDirs += next.removedDirs;
  target.freedBytes += next.freedBytes;
}

async function ensureSafeMutationState(): Promise<void> {
  const reason = await unsafeMutationReason();
  if (reason) {
    throw new Error(`${reason} Drain or resolve that work before changing mode or binding. Use \`bridgectl inbox\` or restart the existing binding first.`);
  }
}

function renderBinding(binding: BoundThread | null): string {
  if (!binding) {
    return "none";
  }
  return [
    `thread=${binding.threadId}`,
    `cwd=${binding.cwd}`,
    `rollout=${binding.rolloutPath}`,
    `source=${binding.source}`,
  ].join(" ");
}

function safeUrlForStatus(url: string | null | undefined): string {
  return url ? redactUrlForLogs(url) : "none";
}

async function commandStatus(): Promise<void> {
  const pid = await resolveDaemonPid();
  const gatewayPid = await resolveGatewayPid();
  const activeTask = state.getActiveTask();
  const desktopTurn = await currentDesktopTurnActivity();
  const activeCall = getActiveCall();
  const recentCall = summarizeRecentCall(state.getRecentCallSummary(), config.repoRoot);
  const daemonStartedAt = pid ? await processStartedAt(pid) : null;
  const recentFailedTask = summarizeRecentFailedTask(state.getMostRecentFailedTaskSince(daemonStartedAt));
  const artifactFailures = state.getArtifactDeliveryFailureSummary();
  const callSurface = await syncManagedTunnelState();
  const realtimeBudget = currentRealtimeBudget();
  const activeCallLabel = activeCallStatusLabel(activeCall);
  let gatewayReady = false;
  let gatewayBridgeReady = false;
  let bridgeReady = false;
  let publicCallReady = false;
  let publicCallIssue = "call surface is disarmed";
  const daemonIssue = await describeDaemonIssue(pid);
  gatewayReady = await fetchOk(gatewayReadyUrl());
  gatewayBridgeReady = await effectiveGatewayBridgeReady(gatewayReady, pid);
  bridgeReady = await fetchOk(`http://127.0.0.1:${config.codex.app_server_port}/readyz`);
  const publicSurface = await probeRealtimePublicSurface(config, callSurface);
  publicCallReady = publicSurface.ready;
  publicCallIssue = summarizePublicCallIssue({
    surface: callSurface,
    gatewayReady,
    gatewayBridgeReady,
    publicSurfaceReady: publicSurface.ready,
    publicSurfaceDetail: publicSurface.detail,
    daemonIssue,
  });
  const callStart = resolveCallStartResolution({
    activeTask,
    activeCall,
    queuedTasks: state.getQueuedTaskCount(),
    pendingApprovals: state.getPendingApprovalCount(),
    pendingCallHandoffs: state.getPendingCallHandoffCount(),
    owner: getOwner(),
    binding: state.getBoundThread(),
    desktopTurnId: desktopTurn.active ? desktopTurn.turnId ?? "(unknown turn)" : null,
    explicitLiveCall: true,
    interactiveBlocker: describeCallStartBlocker({
      surface: callSurface,
      activeCall,
      gatewayReady,
      gatewayBridgeReady,
      publicSurface,
    }),
  });
  const effectivePublicReady = gatewayReady && gatewayBridgeReady && publicSurface.ready;
  const recentCallEvents = summarizeRecentCallSurfaceEvents(callSurface);
  const liveCallPriority = describeLiveCallPriorityHint({
    activeTask,
    queuedTasks: state.getQueuedTaskCount(),
    pendingCallHandoffs: state.getPendingCallHandoffCount(),
  });
  const managedTunnelCooldown = callSurface.tunnelMode === "managed-quick-cloudflared"
    ? getManagedTunnelRecoveryCooldown(state)
    : null;
  const managedTunnelCooldownSummary = managedTunnelCooldown
    ? managedTunnelRecoveryCooldownDetail(managedTunnelCooldown)
    : null;
  const lines = [
    `gatewayPid=${gatewayPid ?? "none"}`,
    `gatewayReady=${gatewayReady ? "true" : "false"}`,
    `gatewayBridgeReady=${gatewayBridgeReady ? "true" : "false"}`,
    `pid=${pid ?? "none"}`,
    `running=${pid ? "true" : "false"}`,
    `bridgeReady=${bridgeReady ? "true" : "false"}`,
    `daemonIssue=${daemonIssue ?? "none"}`,
    `callSurfaceArmed=${callSurface.armed ? "true" : "false"}`,
    `callSurfaceStatus=${currentCallSurfaceLabel(callSurface, effectivePublicReady, activeCall)}`,
    `callSurfaceExpiresIn=${formatSurfaceExpiry(callSurface.expiresAt)}`,
    `tunnelMode=${callSurface.tunnelMode}`,
    `tunnelPid=${callSurface.tunnelPid ?? "none"}`,
    `tunnelUrl=${callSurface.tunnelUrl ?? "none"}`,
    `launchTokenReady=${launchTokenReadyForCurrentBridge(callSurface) ? "true" : "false"}`,
    `launchTokenState=${describeLaunchTokenState(callSurface)}`,
    `publicCallReady=${effectivePublicReady ? "true" : "false"}`,
    `publicCallIssue=${publicCallIssue}`,
    `mode=${getMode()}`,
    `owner=${getOwner()}`,
    `sleeping=${state.isSleeping()}`,
    `binding=${renderBinding(state.getBoundThread())}`,
    `desktopTurnActive=${desktopTurn.active ? "true" : "false"}`,
    `desktopTurnId=${desktopTurn.turnId ?? "none"}`,
    `activeCall=${activeCallLabel && activeCall ? `${activeCall.callId}:${activeCallLabel}` : "none"}`,
    `activeTask=${activeTask ? `${activeTask.queueId}:${activeTask.stage}` : "none"}`,
    `activeTaskStartedAt=${activeTask ? formatTimestamp(activeTask.startedAt) : "none"}`,
    `activeTaskAge=${activeTask ? formatAgeSeconds(activeTask.startedAt) : "none"}`,
    `activeTaskThreadId=${activeTask?.threadId ?? "none"}`,
    `activeTaskBoundThreadId=${activeTask?.boundThreadId ?? "none"}`,
    `activeTaskTurnId=${activeTask?.turnId ?? "none"}`,
    `recentFailedTask=${recentFailedTask.label}`,
    `recentFailedTaskAt=${recentFailedTask.updatedAt}`,
    `recentFailedTaskError=${recentFailedTask.error}`,
    `artifactDeliveryFailed=${artifactFailures.failed}`,
    `artifactDeliveryRetryable=${artifactFailures.retryable}`,
    `artifactDeliveryQuarantined=${artifactFailures.quarantined}`,
    `recentCall=${recentCall.label}`,
    `recentCallEndedAt=${recentCall.endedAt}`,
    `recentCallTranscript=${recentCall.transcript}`,
    `recentCallHandoff=${recentCall.handoff}`,
    `recentCallBundle=${recentCall.bundle}`,
    `recentCallAppendStatus=${recentCall.appendStatus}`,
    `queue=${state.getQueuedTaskCount()}`,
    `pendingApprovals=${state.getPendingApprovalCount()}`,
    `pendingCallHandoffs=${state.getPendingCallHandoffCount()}`,
    `lastDisarmReason=${callSurface.lastDisarmReason ?? "none"}`,
    `lastPublicProbeAt=${formatTimestamp(callSurface.lastPublicProbeAt)}`,
    `lastPublicProbeReady=${callSurface.lastPublicProbeReady === null ? "none" : callSurface.lastPublicProbeReady ? "true" : "false"}`,
    `lastPublicProbeDetail=${callSurface.lastPublicProbeDetail ?? "none"}`,
    `lastPublicUrl=${safeUrlForStatus(callSurface.lastPublicUrl)}`,
    `lastHealthUrl=${safeUrlForStatus(callSurface.lastHealthUrl)}`,
    `lastLaunchUrl=${safeUrlForStatus(callSurface.lastLaunchUrl)}`,
    `managedTunnelCooldown=${managedTunnelCooldownSummary ?? "none"}`,
    `realtimeCallsToday=${realtimeBudget.callsToday}`,
    `realtimeUsed=${formatRealtimeBudgetSeconds(realtimeBudget.usedMs)}`,
    `realtimeRemaining=${formatRealtimeBudgetSeconds(realtimeBudget.remainingMs)}`,
    `realtimeNextCallCap=${formatRealtimeBudgetSeconds(realtimeBudget.nextCallCapMs)}`,
    `callStartBlocker=${callStart.summary}`,
    `liveCallPriority=${liveCallPriority ?? "none"}`,
    `recentCallEventCount=${recentCallEvents.length}`,
  ];
  if (managedTunnelCooldownSummary) {
    lines.push("callStartNextStep=Wait for the managed tunnel cooldown to expire, or configure realtime.tunnel_mode=\"static-public-url\" with a stable public origin.");
  } else if (callStart.blocked) {
    lines.push(`callStartNextStep=${callStart.nextStep}`);
  }
  recentCallEvents.forEach((entry, index) => lines.push(`recentCallEvent${index + 1}=${entry}`));
  console.log(lines.join("\n"));
}

function recentTaskWatchRows(limit: number): Array<{
  id: string;
  kind: string;
  status: string;
  text: string;
  placeholder_message_id: number | null;
  created_at: number;
  updated_at: number;
}> {
  return state.db.prepare(`
    SELECT id, kind, status, text, placeholder_message_id, created_at, updated_at
    FROM message_queue
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(limit) as Array<{
    id: string;
    kind: string;
    status: string;
    text: string;
    placeholder_message_id: number | null;
    created_at: number;
    updated_at: number;
  }>;
}

async function buildWatchSnapshot(limit: number): Promise<string> {
  const activeTask = state.getActiveTask();
  const activeCall = getActiveCall();
  const desktopTurn = await currentDesktopTurnActivity();
  const surface = await syncManagedTunnelState();
  const daemonPid = await resolveDaemonPid();
  const daemonIssue = await describeDaemonIssue(daemonPid);
  const gatewayReady = await fetchOk(gatewayReadyUrl());
  const gatewayBridgeReady = await effectiveGatewayBridgeReady(gatewayReady, daemonPid);
  const publicSurface = await probeRealtimePublicSurface(config, surface, publicSurfaceProbeOptions(1_000));
  const effectivePublicReady = gatewayReady && gatewayBridgeReady && publicSurface.ready;
  const daemonStartedAt = daemonPid ? await processStartedAt(daemonPid) : null;
  const recentFailedTask = summarizeRecentFailedTask(state.getMostRecentFailedTaskSince(daemonStartedAt));
  const recentCall = summarizeRecentCall(state.getRecentCallSummary(), config.repoRoot);
  const callStart = resolveCallStartResolution({
    activeTask,
    activeCall,
    queuedTasks: state.getQueuedTaskCount(),
    pendingApprovals: state.getPendingApprovalCount(),
    pendingCallHandoffs: state.getPendingCallHandoffCount(),
    owner: getOwner(),
    binding: state.getBoundThread(),
    desktopTurnId: desktopTurn.active ? desktopTurn.turnId ?? "(unknown turn)" : null,
    explicitLiveCall: true,
    interactiveBlocker: describeCallStartBlocker({
      surface,
      activeCall,
      gatewayReady,
      gatewayBridgeReady,
      publicSurface,
    }),
  });
  const rows = recentTaskWatchRows(limit);
  const lines = [
    `owner=${getOwner()}`,
    `mode=${getMode()}`,
    `desktopTurnActive=${desktopTurn.active ? "true" : "false"}`,
    `desktopTurnId=${desktopTurn.turnId ?? "none"}`,
    `activeTask=${activeTask ? `${activeTask.queueId}:${activeTask.stage}` : "none"}`,
    `activeCall=${activeCall ? `${activeCall.callId}:${activeCall.status}` : "none"}`,
    `queue=${state.getQueuedTaskCount()}`,
    `callSurface=${currentCallSurfaceLabel(surface, effectivePublicReady, activeCall)}`,
    `publicCallReady=${effectivePublicReady ? "true" : "false"}`,
    `publicCallIssue=${summarizePublicCallIssue({
      surface,
      gatewayReady,
      gatewayBridgeReady,
      publicSurfaceReady: publicSurface.ready,
      publicSurfaceDetail: publicSurface.detail,
      daemonIssue,
    })}`,
    `callStartBlocker=${callStart.summary}`,
    `recentFailedTask=${recentFailedTask.label}`,
    `recentFailedTaskError=${recentFailedTask.error}`,
    `recentCall=${recentCall.label}`,
    `recentCallAppendStatus=${recentCall.appendStatus}`,
  ];
  if (callStart.blocked) {
    lines.push(`callStartNextStep=${callStart.nextStep}`);
  }
  if (rows.length === 0) {
    lines.push("recentTasks=none");
    return lines.join("\n");
  }
  lines.push("recentTasks:");
  lines.push(...rows.map(row => [
    `${row.id}`,
    `${row.kind}`,
    `${row.status}`,
    `placeholder=${row.placeholder_message_id ?? "none"}`,
    `created=${new Date(row.created_at).toISOString()}`,
    `updated=${new Date(row.updated_at).toISOString()}`,
    `text=${row.text}`,
  ].join(" | ")));
  return lines.join("\n");
}

async function commandWatch(args: string[]): Promise<void> {
  const seconds = parseOptionalSeconds(args, 120);
  const intervalMs = parseOptionalIntervalMs(args, 1_000);
  const limit = parseOptionalLimit(args) ?? 5;
  let priorSnapshot = "";
  const deadline = seconds > 0 ? Date.now() + seconds * 1_000 : Number.POSITIVE_INFINITY;

  while (Date.now() <= deadline) {
    const nextSnapshot = await buildWatchSnapshot(limit);
    if (nextSnapshot !== priorSnapshot) {
      if (priorSnapshot) {
        console.log("");
      }
      console.log(`[${new Date().toISOString()}]`);
      console.log(nextSnapshot);
      priorSnapshot = nextSnapshot;
    }
    if (Date.now() + intervalMs > deadline) {
      break;
    }
    await sleep(intervalMs);
  }
}

async function commandCapabilities(): Promise<void> {
  const daemonPid = await resolveDaemonPid();
  const daemonIssue = await describeDaemonIssue(daemonPid);
  const gatewayReady = await fetchOk(gatewayReadyUrl());
  const gatewayBridgeReady = await effectiveGatewayBridgeReady(gatewayReady, daemonPid);
  const surface = await syncManagedTunnelState();
  const publicSurface = await probeRealtimePublicSurface(config, surface, {
    timeoutMs: 1_500,
    ...publicSurfaceProbeOptions(),
  });
  const realtimePublicReady = surface.armed && gatewayReady && gatewayBridgeReady && publicSurface.ready;
  const realtimePublicDetail = realtimePublicReady
    ? null
    : summarizePublicCallIssue({
      surface,
      gatewayReady,
      gatewayBridgeReady,
      publicSurfaceReady: publicSurface.ready,
      publicSurfaceDetail: publicSurface.detail,
      daemonIssue,
    });
  const status = state.getBoundThread();
  const desktopTurn = await currentDesktopTurnActivity();
  const callStart = resolveCallStartResolution({
    activeTask: state.getActiveTask(),
    activeCall: getActiveCall(),
    queuedTasks: state.getQueuedTaskCount(),
    pendingApprovals: state.getPendingApprovalCount(),
    pendingCallHandoffs: state.getPendingCallHandoffCount(),
    owner: getOwner(),
    binding: status,
    desktopTurnId: desktopTurn.active ? desktopTurn.turnId ?? "(unknown turn)" : null,
    explicitLiveCall: true,
  });
  const executionCwd = status?.cwd ?? (config.codex.workdir || null);
  const lines = renderCapabilityLines(config, env, state, {
    runtime: {
      mode: getMode(),
      owner: getOwner(),
      binding: status,
      threadId: null,
      cwd: executionCwd,
      daemonRunning: Boolean(daemonPid),
      daemonIssue,
      gatewayReady,
      gatewayBridgeReady,
      realtimePublicReady,
      realtimePublicDetail,
      launchTokenReady: launchTokenReadyForCurrentBridge(surface),
      realtimeStartBlocker: callStart.blocked ? callStart.summary : null,
    },
    chains: {
      asr: registry.getEffectiveChain("asr"),
      tts: registry.getEffectiveChain("tts"),
      image_generation: registry.getEffectiveChain("image_generation"),
    },
    providerStatuses: await registry.getProviderStatuses(),
  });
  console.log(lines.join("\n"));
}

async function commandGatewayStart(): Promise<void> {
  if (!config.realtime.enabled) {
    throw new Error("Realtime is disabled in bridge.config.toml.");
  }
  const pid = await resolveGatewayPid();
  if (pid) {
    throw new Error(`realtime-gateway is already running with pid ${pid}`);
  }
  const started = await startGatewayIfNeeded();
  console.log(`started realtime-gateway (pid ${started.pid ?? "unknown"})`);
}

async function commandGatewayStop(): Promise<void> {
  const pid = await stopGatewayIfRunning();
  if (!pid) {
    console.log("realtime-gateway is not running");
    return;
  }
  console.log(`sent SIGTERM to realtime-gateway pid ${pid}`);
}

async function commandGatewayStatus(): Promise<void> {
  const pid = await resolveGatewayPid();
  const daemonPid = await resolveDaemonPid();
  const daemonIssue = await describeDaemonIssue(daemonPid);
  const ready = await fetchOk(gatewayReadyUrl());
  const bridgeReady = await effectiveGatewayBridgeReady(ready, daemonPid);
  const surface = await syncManagedTunnelState();
  const publicSurface = await probeRealtimePublicSurface(config, surface, publicSurfaceProbeOptions());
  const effectivePublicReady = ready && bridgeReady && publicSurface.ready;
  console.log([
    `gatewayPid=${pid ?? "none"}`,
    `gatewayReady=${ready ? "true" : "false"}`,
    `gatewayBridgeReady=${bridgeReady ? "true" : "false"}`,
    `callSurfaceArmed=${surface.armed ? "true" : "false"}`,
    `callSurfaceStatus=${currentCallSurfaceLabel(surface, effectivePublicReady)}`,
    `tunnelMode=${surface.tunnelMode}`,
    `tunnelPid=${surface.tunnelPid ?? "none"}`,
    `tunnelUrl=${surface.tunnelUrl ?? "none"}`,
    `launchUrl=${safeUrlForStatus(publicSurface.launchUrl)}`,
    `publicCallReady=${effectivePublicReady ? "true" : "false"}`,
    `publicCallIssue=${summarizePublicCallIssue({
      surface,
      gatewayReady: ready,
      gatewayBridgeReady: bridgeReady,
      publicSurfaceReady: publicSurface.ready,
      publicSurfaceDetail: publicSurface.detail,
      daemonIssue,
    })}`,
    `gatewayUrl=${gatewayReadyUrl()}`,
  ].join("\n"));
}

function gatewayApiBase(): string {
  return `http://${config.realtime.gateway_host}:${config.realtime.gateway_port}`;
}

async function ensureRealtimeGatewayBridgeReady(): Promise<void> {
  if (!await fetchOk(gatewayReadyUrl())) {
    throw new Error("Realtime gateway is not ready. Start or repair the gateway before launching a call.");
  }
  if (!await gatewayBridgeConnected()) {
    throw new Error("Realtime gateway is up, but the local bridge control channel is not connected.");
  }
}

async function waitForRealtimeGatewayBridgeReady(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fetchOk(gatewayReadyUrl()) && await gatewayBridgeConnected()) {
      return;
    }
    await sleep(250);
  }
  throw new Error("Realtime gateway is running, but the local bridge control channel did not connect in time.");
}

async function waitForPublicCallSurfaceReady(
  surface: RealtimeCallSurfaceRecord,
  timeoutMs = 20_000,
): Promise<Awaited<ReturnType<typeof probeRealtimePublicSurface>>> {
  const deadline = Date.now() + timeoutMs;
  let last = await probeRealtimePublicSurface(config, surface, publicSurfaceProbeOptions());
  while (Date.now() < deadline) {
    if (last.ready) {
      return last;
    }
    await sleep(500);
    last = await probeRealtimePublicSurface(config, surface, publicSurfaceProbeOptions());
  }
  return last;
}

async function ensureCallCanStart(options: {
  explicit?: boolean;
} = {}): Promise<void> {
  if (!config.realtime.enabled) {
    throw new Error("Realtime is disabled in bridge.config.toml.");
  }
  const maxCallMs = currentCallBudgetCapMs();
  if (maxCallMs <= 0) {
    const usage = state.getRealtimeUsage();
    throw new Error(
      `Today's realtime call budget is exhausted (${Math.round(usage.totalCallMs / 1000)}s used of `
      + `${Math.round(config.realtime.max_daily_call_ms / 1000)}s).`,
    );
  }
  const activeCall = getActiveCall();
  if (callNeedsFinalization(activeCall)) {
    throw new Error(
      isCallLive(activeCall)
        ? `Live call ${activeCall.callId} is already ${activeCall.status}.`
        : `Call ${activeCall.callId} is still being finalized.`,
    );
  }
  const pendingApprovals = state.getPendingApprovalCount();
  if (pendingApprovals > 0) {
    throw new Error("Pending approvals must be resolved before starting a live call.");
  }
  if (shouldBlockPendingCallHandoffForLiveCall({
    pendingCallHandoffs: state.getPendingCallHandoffCount(),
    explicitLiveCall: options.explicit,
  })) {
    throw new Error("A previous call handoff is still waiting to be appended into Codex. Let it flush before starting another live call.");
  }
  if (getOwner() !== "telegram") {
    throw new Error("Telegram must own the session before a live call can start.");
  }
  if (!state.getBoundThread()) {
    throw new Error("Attach a desktop Codex thread before starting a live call.");
  }
}

async function ensureCallSurfaceCanArm(input: {
  gatewayReady?: boolean;
  gatewayConnected?: boolean;
} = {}): Promise<void> {
  if (!config.realtime.enabled) {
    throw new Error("Realtime is disabled in bridge.config.toml.");
  }
  const blocker = describeCallArmBlocker({
    activeCall: getActiveCall(),
    owner: getOwner(),
    binding: state.getBoundThread(),
    gatewayReady: input.gatewayReady,
    gatewayConnected: input.gatewayConnected,
  });
  if (blocker) {
    throw new Error([blocker.summary, blocker.nextStep].join(" "));
  }
}

async function ensureArmedCallSurfaceReady(): Promise<{
  surface: RealtimeCallSurfaceRecord;
  publicSurface: Awaited<ReturnType<typeof probeRealtimePublicSurface>>;
}> {
  await ensureCallCanStart({ explicit: true });
  const surface = refreshLaunchToken(await syncManagedTunnelState(), "bridgectl");
  const publicSurface = await probeRealtimePublicSurface(config, surface, publicSurfaceProbeOptions());
  if (!publicSurface.ready || !publicSurface.launchUrl) {
    throw new Error(`Realtime public Mini App is not reachable. ${publicSurface.detail}`);
  }
  await ensureRealtimeGatewayBridgeReady();
  await ensureCallCanStart({ explicit: true });
  return { surface, publicSurface };
}

async function commandCallStart(): Promise<void> {
  try {
    await ensureCallCanStart({ explicit: true });
    await ensureRealtimeGatewayBridgeReady();
    const { surface, publicSurface } = await ensureArmedCallSurfaceReady();
    rememberCallSurfaceEvent({
      action: "start",
      outcome: "ok",
      source: "bridgectl call start",
      detail: "fresh Mini App launch URL minted",
    }, surface);
    console.log(publicSurface.launchUrl);
  } catch (error) {
    rememberCallSurfaceEvent({
      action: "start",
      outcome: "error",
      source: "bridgectl call start",
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function commandCallArm(): Promise<void> {
  try {
    await ensureCallSurfaceCanArm();
    const { surface, publicSurface } = await armCallSurface("bridgectl");
    const desktopTurn = await currentDesktopTurnActivity();
    const daemonPid = await resolveDaemonPid();
    const daemonIssue = await describeDaemonIssue(daemonPid);
    const gatewayReady = await fetchOk(gatewayReadyUrl());
    const gatewayBridgeReady = await effectiveGatewayBridgeReady(gatewayReady, daemonPid);
    const effectivePublicReady = gatewayReady && gatewayBridgeReady && publicSurface.ready;
    const callStart = resolveCallStartResolution({
      activeTask: state.getActiveTask(),
      activeCall: getActiveCall(),
      queuedTasks: state.getQueuedTaskCount(),
      pendingApprovals: state.getPendingApprovalCount(),
      pendingCallHandoffs: state.getPendingCallHandoffCount(),
      owner: getOwner(),
      binding: state.getBoundThread(),
      desktopTurnId: desktopTurn.active ? desktopTurn.turnId ?? "(unknown turn)" : null,
      explicitLiveCall: true,
      interactiveBlocker: describeCallStartBlocker({
        surface,
        activeCall: getActiveCall(),
        gatewayReady,
        gatewayBridgeReady,
        publicSurface,
      }),
    });
    console.log([
      `callSurfaceArmed=${surface.armed ? "true" : "false"}`,
      `callSurfaceStatus=${currentCallSurfaceLabel(surface, effectivePublicReady)}`,
      `callSurfaceExpiresIn=${formatSurfaceExpiry(surface.expiresAt)}`,
      `tunnelMode=${surface.tunnelMode}`,
      `tunnelPid=${surface.tunnelPid ?? "none"}`,
      `tunnelUrl=${surface.tunnelUrl ?? "none"}`,
      `launchTokenReady=${launchTokenReadyForCurrentBridge(surface) ? "true" : "false"}`,
      `launchTokenState=${describeLaunchTokenState(surface)}`,
      `launchUrl=${safeUrlForStatus(publicSurface.launchUrl)}`,
      `publicCallReady=${effectivePublicReady ? "true" : "false"}`,
      `publicCallIssue=${summarizePublicCallIssue({
        surface,
        gatewayReady,
        gatewayBridgeReady,
        publicSurfaceReady: publicSurface.ready,
        publicSurfaceDetail: publicSurface.detail,
        daemonIssue,
      })}`,
      `callStartBlocked=${callStart.blocked ? "true" : "false"}`,
      `callStartBlocker=${callStart.summary}`,
      `callStartNextStep=${callStart.nextStep}`,
      `lastDisarmReason=${surface.lastDisarmReason ?? "none"}`,
      `lastPublicProbeAt=${formatTimestamp(surface.lastPublicProbeAt)}`,
      `lastPublicProbeReady=${surface.lastPublicProbeReady === null ? "none" : surface.lastPublicProbeReady ? "true" : "false"}`,
      `lastPublicProbeDetail=${surface.lastPublicProbeDetail ?? "none"}`,
      `lastPublicUrl=${safeUrlForStatus(surface.lastPublicUrl)}`,
      `lastHealthUrl=${safeUrlForStatus(surface.lastHealthUrl)}`,
      `lastLaunchUrl=${safeUrlForStatus(surface.lastLaunchUrl)}`,
      `realtimeNextCallCap=${formatRealtimeBudgetSeconds(currentCallBudgetCapMs())}`,
    ].join("\n"));
  } catch (error) {
    rememberCallSurfaceEvent({
      action: "arm",
      outcome: "error",
      source: "bridgectl call arm",
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function commandCallInvite(args: string[]): Promise<void> {
  try {
    if (!telegram) {
      throw new Error(missingTelegramBotTokenForCallInviteMessage());
    }
    await ensureCallCanStart({ explicit: true });
    await ensureRealtimeGatewayBridgeReady();
    const surface = refreshLaunchToken(await syncManagedTunnelState(), "bridgectl invite");
    const publicSurface = await probeRealtimePublicSurface(config, surface, publicSurfaceProbeOptions());
    if (!publicSurface.ready) {
      throw new Error(`Realtime public Mini App is not reachable. Refusing to send a dead call invite. ${publicSurface.detail}`);
    }
    await ensureRealtimeGatewayBridgeReady();
    await ensureCallCanStart({ explicit: true });
    const replyMarkup = buildCallLaunchMarkup(config, surface);
    const launchUrl = buildCallLaunchUrl(config, surface);
    if (!replyMarkup || !launchUrl) {
      throw new Error("Live call surface does not have a usable launch URL.");
    }
    const note = args.join(" ").trim();
    await ensureRealtimeGatewayBridgeReady();
    await ensureCallCanStart({ explicit: true });
    const sent = await telegram.sendMessage(
      config.telegram.authorized_chat_id,
      buildCallInviteText(config, note || `${config.realtime.bridge_id} is ready to talk live.`),
      { replyMarkup },
    );
    rememberCallSurfaceEvent({
      action: "invite",
      outcome: "ok",
      source: "bridgectl call invite",
      detail: `Telegram invite message ${sent.message_id} sent`,
    }, surface);
    console.log([
      `sentMessageId=${sent.message_id}`,
      `chatId=${maskIdentifier(config.telegram.authorized_chat_id)}`,
      `launchUrl=${safeUrlForStatus(launchUrl)}`,
    ].join("\n"));
  } catch (error) {
    rememberCallSurfaceEvent({
      action: "invite",
      outcome: "error",
      source: "bridgectl call invite",
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function commandCallDisarm(): Promise<void> {
  const activeCall = getActiveCall();
  if (callNeedsFinalization(activeCall)) {
    throw new Error("A live or finalizing call is still active. Use `bridgectl call hangup` first and wait for cleanup to finish.");
  }
  const surface = await disarmManagedCallSurface("bridgectl call disarm");
  console.log([
    `callSurfaceArmed=${surface.armed ? "true" : "false"}`,
    `callSurfaceStatus=${currentCallSurfaceLabel(surface, false)}`,
    `tunnelMode=${surface.tunnelMode}`,
    `tunnelPid=${surface.tunnelPid ?? "none"}`,
    `tunnelUrl=${surface.tunnelUrl ?? "none"}`,
    "publicCallReady=false",
  ].join("\n"));
}

async function commandCallHangup(): Promise<void> {
  const activeCall = getActiveCall();
  if (!activeCall || !["starting", "active", "finalizing"].includes(activeCall.status)) {
    console.log("No live call is active.");
    return;
  }
  if (!env.realtimeControlSecret) {
    throw new Error(missingRealtimeControlSecretMessage());
  }
  const response = await fetch(`${gatewayApiBase()}/api/call/hangup`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bridge-secret": env.realtimeControlSecret,
    },
    body: JSON.stringify({
      bridgeId: config.realtime.bridge_id,
      callId: activeCall.callId,
      reason: "bridgectl_hangup",
    }),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  console.log(`hangup requested for ${activeCall.callId}`);
}

async function commandCallStatus(): Promise<void> {
  const activeCall = getActiveCall();
  const surface = await syncManagedTunnelState();
  const desktopTurn = await currentDesktopTurnActivity();
  const daemonPid = await resolveDaemonPid();
  const daemonIssue = await describeDaemonIssue(daemonPid);
  const gatewayReady = await fetchOk(gatewayReadyUrl());
  const gatewayBridgeReady = await effectiveGatewayBridgeReady(gatewayReady, daemonPid);
  const publicSurface = await probeRealtimePublicSurface(config, surface, publicSurfaceProbeOptions());
  const effectivePublicReady = gatewayReady && gatewayBridgeReady && publicSurface.ready;
  const recentCall = summarizeRecentCall(state.getRecentCallSummary(), config.repoRoot);
  const daemonStartedAt = daemonPid ? await processStartedAt(daemonPid) : null;
  const recentFailedTask = summarizeRecentFailedTask(state.getMostRecentFailedTaskSince(daemonStartedAt));
  const recentCallEvents = summarizeRecentCallSurfaceEvents(surface);
  const liveCallPriority = describeLiveCallPriorityHint({
    activeTask: state.getActiveTask(),
    queuedTasks: state.getQueuedTaskCount(),
    pendingCallHandoffs: state.getPendingCallHandoffCount(),
  });
  const callStart = resolveCallStartResolution({
    activeTask: state.getActiveTask(),
    activeCall,
    queuedTasks: state.getQueuedTaskCount(),
    pendingApprovals: state.getPendingApprovalCount(),
    pendingCallHandoffs: state.getPendingCallHandoffCount(),
    owner: getOwner(),
    binding: state.getBoundThread(),
    desktopTurnId: desktopTurn.active ? desktopTurn.turnId ?? "(unknown turn)" : null,
    explicitLiveCall: true,
    interactiveBlocker: describeCallStartBlocker({
      surface,
      activeCall,
      gatewayReady,
      gatewayBridgeReady,
      publicSurface,
    }),
  });
  const managedTunnelCooldown = surface.tunnelMode === "managed-quick-cloudflared"
    ? getManagedTunnelRecoveryCooldown(state)
    : null;
  const managedTunnelCooldownSummary = managedTunnelCooldown
    ? managedTunnelRecoveryCooldownDetail(managedTunnelCooldown)
    : null;
  const lines = [
    `callSurfaceArmed=${surface.armed ? "true" : "false"}`,
    `callSurfaceStatus=${currentCallSurfaceLabel(surface, effectivePublicReady, activeCall)}`,
    `callSurfaceExpiresIn=${formatSurfaceExpiry(surface.expiresAt)}`,
    `tunnelMode=${surface.tunnelMode}`,
    `tunnelPid=${surface.tunnelPid ?? "none"}`,
    `tunnelUrl=${surface.tunnelUrl ?? "none"}`,
    `launchTokenReady=${launchTokenReadyForCurrentBridge(surface) ? "true" : "false"}`,
    `publicCallReady=${effectivePublicReady ? "true" : "false"}`,
    `publicCallIssue=${summarizePublicCallIssue({
      surface,
      gatewayReady,
      gatewayBridgeReady,
      publicSurfaceReady: publicSurface.ready,
      publicSurfaceDetail: publicSurface.detail,
      daemonIssue,
    })}`,
    `callStartBlocker=${callStart.summary}`,
    `liveCallPriority=${liveCallPriority ?? "none"}`,
    `recentFailedTask=${recentFailedTask.label}`,
    `recentFailedTaskAt=${recentFailedTask.updatedAt}`,
    `recentFailedTaskError=${recentFailedTask.error}`,
    `recentCall=${recentCall.label}`,
    `recentCallEndedAt=${recentCall.endedAt}`,
    `recentCallTranscript=${recentCall.transcript}`,
    `recentCallHandoff=${recentCall.handoff}`,
    `recentCallBundle=${recentCall.bundle}`,
    `recentCallAppendStatus=${recentCall.appendStatus}`,
    `lastDisarmReason=${surface.lastDisarmReason ?? "none"}`,
    `lastPublicProbeAt=${formatTimestamp(surface.lastPublicProbeAt)}`,
    `lastPublicProbeReady=${surface.lastPublicProbeReady === null ? "none" : surface.lastPublicProbeReady ? "true" : "false"}`,
    `lastPublicProbeDetail=${surface.lastPublicProbeDetail ?? "none"}`,
    `lastPublicUrl=${safeUrlForStatus(surface.lastPublicUrl)}`,
    `lastHealthUrl=${safeUrlForStatus(surface.lastHealthUrl)}`,
    `lastLaunchUrl=${safeUrlForStatus(surface.lastLaunchUrl)}`,
    `managedTunnelCooldown=${managedTunnelCooldownSummary ?? "none"}`,
    `realtimeNextCallCap=${formatRealtimeBudgetSeconds(currentCallBudgetCapMs())}`,
    `callStartNextStep=${managedTunnelCooldownSummary ? "Wait for the managed tunnel cooldown to expire, or configure realtime.tunnel_mode=\"static-public-url\" with a stable public origin." : callStart.nextStep}`,
    `recentCallEventCount=${recentCallEvents.length}`,
  ];
  recentCallEvents.forEach((entry, index) => lines.push(`recentCallEvent${index + 1}=${entry}`));
  if (!activeCall) {
    lines.push("callId=none");
    console.log(lines.join("\n"));
    return;
  }
  lines.push(
    `callId=${activeCall.callId}`,
    `status=${activeCall.status}`,
    `startedAt=${new Date(activeCall.startedAt).toISOString()}`,
    `endedAt=${activeCall.endedAt ? new Date(activeCall.endedAt).toISOString() : "none"}`,
    `endedReason=${activeCall.endedReason ?? "none"}`,
    `boundThreadId=${activeCall.boundThreadId ?? "none"}`,
    `cwd=${activeCall.cwd ?? "none"}`,
    `inCallInbox=${state.getCallInboxCount(activeCall.callId)}`,
  );
  console.log(lines.join("\n"));
}

async function commandCleanup(args: string[]): Promise<void> {
  await ensureDaemonStoppedForMutation();
  await ensureSafeMutationState();

  const days = parseOptionalDays(args, config.storage.retention_days);
  const cutoffMs = Date.now() - (days * 24 * 60 * 60 * 1000);
  const callsRoot = ensureDir(join(config.storageRoot, "calls"));
  const stats: StorageCleanupStats = {
    scannedEntries: 0,
    removedFiles: 0,
    removedDirs: 0,
    freedBytes: 0,
  };
  let purgedDeliveredArtifactRows = 0;

  mergeCleanupStats(stats, await cleanupEmptyTimeoutCallArtifacts(callsRoot, Date.now() - (60 * 60 * 1000)));

  const keepPaths = state.getRetentionProtectedPaths();
  mergeCleanupStats(
    stats,
    await cleanupStorageRoots(
      [
        join(config.storageRoot, "artifacts"),
        join(config.storageRoot, "inbound"),
        join(config.storageRoot, "log-archive"),
        join(config.storageRoot, "normalized"),
        join(config.storageRoot, "outbound"),
        callsRoot,
      ],
      cutoffMs,
      { keepPaths },
    ),
  );

  if (shouldPurgeDeliveredArtifacts(args)) {
    const purgeableArtifacts = state
      .listArtifactsForCleanup({ olderThan: cutoffMs, deliveredOnly: true })
      .filter(artifact => !keepPaths.includes(artifact.path));
    const removedIds: string[] = [];
    for (const artifact of purgeableArtifacts) {
      await rm(artifact.path, { force: true }).catch(() => undefined);
      removedIds.push(artifact.id);
    }
    state.deleteArtifacts(removedIds);
    purgedDeliveredArtifactRows = removedIds.length;
  }

  const prunedArtifactRows = state.pruneMissingArtifactRecords();

  console.log([
    `days=${days}`,
    `purgedDeliveredArtifacts=${shouldPurgeDeliveredArtifacts(args) ? "true" : "false"}`,
    `removedFiles=${stats.removedFiles}`,
    `removedDirs=${stats.removedDirs}`,
    `freedBytes=${stats.freedBytes}`,
    `purgedDeliveredArtifactRows=${purgedDeliveredArtifactRows}`,
    `prunedArtifactRows=${prunedArtifactRows}`,
  ].join("\n"));
}

function sendAllowedRoots(): string[] {
  const roots = new Set<string>();
  roots.add(resolve(process.cwd()));
  roots.add(resolve(config.codex.workdir));
  const boundThread = state.getBoundThread();
  if (boundThread?.cwd) {
    roots.add(resolve(boundThread.cwd));
  }
  return [...roots];
}

function parseSendCommandArgs(args: string[]): { path: string; caption?: string } {
  const filePath = args[0];
  if (!filePath) {
    throw new Error("Usage: bridgectl send <path> [--caption text]");
  }
  const captionIndex = args.indexOf("--caption");
  const caption = captionIndex >= 0 ? args.slice(captionIndex + 1).join(" ").trim() : "";
  return {
    path: resolve(filePath),
    ...(caption ? { caption } : {}),
  };
}

async function commandSend(args: string[]): Promise<void> {
  if (!telegram) {
    throw new Error("TELEGRAM_BOT_TOKEN is required to send files to Telegram.");
  }
  const parsed = parseSendCommandArgs(args);
  const file = await resolveAllowedInspectableFile(parsed.path, sendAllowedRoots());
  const artifact = await artifacts.stageExistingFile({
    modality: file.modality,
    providerId: "bridge",
    source: "automatic",
    sourcePath: file.path,
    mimeType: file.mimeType,
    metadata: {
      kind: "manual-send",
      requestedBy: "bridgectl send",
    },
  });

  const caption = parsed.caption ?? "Local file from the bound desktop session.";
  switch (file.modality) {
    case "image":
      await deliverImageArtifacts({
        telegram,
        chatId: config.telegram.authorized_chat_id,
        artifacts: [artifact],
        markDelivered: artifactId => state.markArtifactDelivered(artifactId),
        markFailed: (artifactId, error) => state.recordArtifactDeliveryFailure(artifactId, error, { quarantine: true }),
        captionForArtifact: () => caption,
      });
      break;
    case "document":
      await deliverDocumentArtifacts({
        telegram,
        chatId: config.telegram.authorized_chat_id,
        artifacts: [artifact],
        markDelivered: artifactId => state.markArtifactDelivered(artifactId),
        markFailed: (artifactId, error) => state.recordArtifactDeliveryFailure(artifactId, error, { quarantine: true }),
        captionForArtifact: () => caption,
      });
      break;
    case "video":
      await deliverVideoArtifacts({
        telegram,
        chatId: config.telegram.authorized_chat_id,
        artifacts: [artifact],
        markDelivered: artifactId => state.markArtifactDelivered(artifactId),
        markFailed: (artifactId, error) => state.recordArtifactDeliveryFailure(artifactId, error, { quarantine: true }),
        captionForArtifact: () => caption,
      });
      break;
    case "audio":
      await deliverAudioArtifacts({
        telegram,
        chatId: config.telegram.authorized_chat_id,
        artifacts: [artifact],
        outputRoot: outboundRoot,
        markDelivered: artifactId => state.markArtifactDelivered(artifactId),
        markFailed: (artifactId, error) => state.recordArtifactDeliveryFailure(artifactId, error, { quarantine: true }),
        captionForArtifact: () => caption,
      });
      break;
  }

  console.log([
    `sentModality=${file.modality}`,
    `chatId=${maskIdentifier(config.telegram.authorized_chat_id)}`,
    `artifactId=${artifact.id}`,
    `path=${file.path}`,
  ].join("\n"));
}

function setBinding(binding: BoundThread | null): void {
  state.setBoundThread(binding);
  if (binding && getMode() === "autonomous-thread") {
    state.setMode("shared-thread-resume");
  }
}

function parseOptionalCwd(args: string[]): string | undefined {
  if (args[0] === "--cwd" && args[1]) {
    return resolve(args[1]);
  }
  return undefined;
}

function parseOptionalLimit(args: string[]): number | undefined {
  const index = args.indexOf("--limit");
  const raw = index >= 0 ? args[index + 1] : undefined;
  if (!raw) {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Limit must be a positive integer.");
  }
  return value;
}

function parseOptionalOwner(args: string[]): BridgeOwner | null {
  const index = args.indexOf("--owner");
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) {
    return null;
  }
  if (!["telegram", "desktop", "none"].includes(value)) {
    throw new Error("Owner must be one of telegram, desktop, or none.");
  }
  return value as BridgeOwner;
}

function maybeParentThreadId(source: string | null | undefined): string | null {
  if (!source || source === "vscode") {
    return null;
  }
  try {
    const parsed = JSON.parse(source) as {
      subagent?: {
        thread_spawn?: {
          parent_thread_id?: string;
        };
      };
    };
    return parsed.subagent?.thread_spawn?.parent_thread_id ?? null;
  } catch {
    return null;
  }
}

function resolveThreadById(threadId: string): BoundThread {
  const binding = locator.findById(threadId);
  if (!binding) {
    throw new Error(`Current Codex thread ${threadId} was not found in desktop state.`);
  }
  const parentThreadId = maybeParentThreadId(binding.source);
  if (!parentThreadId) {
    return binding;
  }
  return locator.findById(parentThreadId) ?? binding;
}

function resolveCurrentBinding(args: string[]): BoundThread {
  const explicitCwd = parseOptionalCwd(args);
  if (!explicitCwd) {
    const threadId = process.env.CODEX_THREAD_ID;
    if (threadId) {
      return resolveThreadById(threadId);
    }
  }
  const cwd = explicitCwd ?? process.cwd();
  return locator.bindCurrent({ cwd });
}

function parseTerminalAskArgs(args: string[]): { prompt: string; timeoutMs: number } {
  const promptParts: string[] = [];
  let timeoutMs = 10 * 60_000;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--timeout-ms") {
      const value = args[index + 1];
      if (!value || !/^\d+$/.test(value)) {
        throw new Error("Usage: bridgectl terminal ask [--timeout-ms <ms>] <prompt>");
      }
      timeoutMs = Number(value);
      index += 1;
      continue;
    }
    promptParts.push(arg);
  }
  const prompt = promptParts.join(" ").trim();
  if (!prompt) {
    throw new Error("Usage: bridgectl terminal ask [--timeout-ms <ms>] <prompt>");
  }
  if (prompt.length > 4_000) {
    throw new Error("Terminal prompt is too long. Keep it under 4000 characters.");
  }
  return { prompt, timeoutMs };
}

async function claimBinding(binding: BoundThread): Promise<void> {
  await ensureSafeMutationState();
  recordShutdownHint({
    source: "signal",
    initiatedBy: "bridgectl claim",
    details: {
      targetThreadId: binding.threadId,
      targetCwd: binding.cwd,
      cwd: process.cwd(),
    },
  });
  await stopDaemonIfRunning();
  await disarmManagedCallSurface("bridgectl claim").catch(() => undefined);
  const previousBinding = state.getBoundThread();
  const previousOwner = state.getOwner("none");
  const previousSleeping = state.isSleeping();
  setBinding(binding);
  state.setOwner("telegram");
  state.setSleeping(false);
  try {
    await commandStart();
  } catch (error) {
    setBinding(previousBinding);
    state.setOwner(previousOwner);
    state.setSleeping(previousSleeping);
    throw error;
  }
  const currentBinding = state.getBoundThread();
  if (!currentBinding || currentBinding.threadId !== binding.threadId) {
    throw new Error(`The Telegram bridge restarted, but the bound thread did not match the requested thread ${binding.threadId}.`);
  }
  if (state.getOwner("none") !== "telegram") {
    throw new Error("The Telegram bridge restarted, but Telegram does not own the session.");
  }
  console.log(`claimed ${binding.threadId}`);
  await commandCapabilities();
}

async function commandTerminal(args: string[]): Promise<void> {
  const action = args[0] ?? "status";
  switch (action) {
    case "status": {
      const status = await getTerminalCodexStatus(config, state);
      console.log([
        renderTerminalCodexStatus(status, terminalCodexIdentity(state)),
        `Configured backend: ${config.terminal_lane.backend}`,
        `Selected backend: ${selectedTerminalBackend(config, state)}`,
        `Override: ${state.getSetting("terminal:backend_override", "none")}`,
        `Profile: ${config.terminal_lane.profile}`,
        `Sandbox: ${config.terminal_lane.sandbox}`,
        `Approvals: ${config.terminal_lane.approval_policy}`,
        `User-owned sessions: ${config.terminal_lane.allow_user_owned_sessions ? "enabled" : "disabled"}`,
        `Terminal control: ${config.terminal_lane.allow_terminal_control ? "enabled" : "disabled"}`,
      ].join("\n"));
      return;
    }
    case "use": {
      const backend = args[1] as TerminalLaneBackend | undefined;
      if (!backend || !["auto", "iterm2", "tmux", "terminal-app"].includes(backend)) {
        throw new Error("Usage: bridgectl terminal use auto|tmux|iterm2|terminal-app");
      }
      if ((backend === "iterm2" || backend === "terminal-app") && !config.terminal_lane.allow_user_owned_sessions) {
        throw new Error("User-owned terminal backends are gated. Set terminal_lane.allow_user_owned_sessions = true first.");
      }
      setTerminalBackendOverride(state, backend);
      setTerminalCodexIdentity(state, null);
      console.log(`terminalBackend=${backend}`);
      return;
    }
    case "init":
    case "start": {
      const identity = await startTerminalCodexWorker(config, state);
      console.log([
        action === "init" ? "terminalInitialized=true" : "terminalStarted=true",
        `backend=${identity.backend}`,
        `session=${identity.name}`,
        `tty=${identity.tty ?? "none"}`,
        `pane=${identity.paneId ?? "none"}`,
        `profile=${identity.profile ?? config.terminal_lane.profile}`,
        `sandbox=${identity.sandbox ?? config.terminal_lane.sandbox}`,
        `approvalPolicy=${identity.approvalPolicy ?? config.terminal_lane.approval_policy}`,
        `daemonOwned=${identity.daemonOwned ? "true" : "false"}`,
        `attachCommand=${terminalAttachCommand(identity.name)}`,
      ].join("\n"));
      return;
    }
    case "stop": {
      const stopped = await stopTerminalCodexWorker(config, state);
      console.log(`terminalStopped=${stopped ? "true" : "false"}`);
      return;
    }
    case "restart": {
      await stopTerminalCodexWorker(config, state);
      const identity = await startTerminalCodexWorker(config, state);
      console.log([
        "terminalRestarted=true",
        `backend=${identity.backend}`,
        `session=${identity.name}`,
        `tty=${identity.tty ?? "none"}`,
        `pane=${identity.paneId ?? "none"}`,
        `profile=${identity.profile ?? config.terminal_lane.profile}`,
        `sandbox=${identity.sandbox ?? config.terminal_lane.sandbox}`,
        `approvalPolicy=${identity.approvalPolicy ?? config.terminal_lane.approval_policy}`,
        `attachCommand=${terminalAttachCommand(identity.name)}`,
      ].join("\n"));
      return;
    }
    case "lock": {
      const identity = await lockTerminalCodexIdentity(config, state);
      console.log([
        "terminalLocked=true",
        `backend=${identity.backend}`,
        `session=${identity.name}`,
        `tty=${identity.tty ?? "none"}`,
        `pane=${identity.paneId ?? "none"}`,
        `daemonOwned=${identity.daemonOwned ? "true" : "false"}`,
      ].join("\n"));
      return;
    }
    case "unlock":
      setTerminalCodexIdentity(state, null);
      console.log("terminalLocked=false");
      return;
    case "ping": {
      const result = await pingTerminalCodex(config, state, { timeoutMs: 90_000, pollIntervalMs: 1_000 });
      console.log([
        `terminalPingObserved=${result.observed ? "true" : "false"}`,
        `backend=${result.session.backend}`,
        `session=${result.session.name}`,
        `tty=${result.session.tty ?? "none"}`,
        `pane=${result.session.paneId ?? "none"}`,
        `marker=${result.marker}`,
        `elapsedMs=${result.elapsedMs}`,
      ].join("\n"));
      return;
    }
    case "ask": {
      const { prompt, timeoutMs } = parseTerminalAskArgs(args);
      const started = await startTerminalCodexAsk(prompt, config, state);
      console.log([
        "terminalAskStarted=true",
        `backend=${started.backend}`,
        `session=${started.session.name}`,
        `tty=${started.session.tty ?? "none"}`,
        `pane=${started.session.paneId ?? "none"}`,
        `marker=${started.marker}`,
      ].join("\n"));
      const result = await waitForTerminalCodexAskCompletion(started, config, state, {
        timeoutMs,
        pollIntervalMs: 1_000,
      });
      console.log([
        `terminalAskObserved=${result.observed ? "true" : "false"}`,
        `elapsedMs=${result.elapsedMs}`,
        result.answerText ? "answer:" : null,
        result.answerText ?? null,
      ].filter(Boolean).join("\n"));
      if (!result.observed) {
        process.exitCode = 1;
      }
      return;
    }
    case "interrupt":
    case "clear": {
      const session = await sendTerminalCodexControl(action, config, state);
      console.log([
        `terminalControl=${action}`,
        `backend=${session.backend}`,
        `session=${session.name}`,
        `tty=${session.tty ?? "none"}`,
        `pane=${session.paneId ?? "none"}`,
      ].join("\n"));
      return;
    }
    case "unlock-superpowers":
      console.log([
        "Terminal superpowers are config-gated; this command prints the required settings instead of editing your config.",
        "To enable a bridge-owned tmux Codex worker with repo write ability:",
        "",
        "[terminal_lane]",
        "enabled = true",
        "backend = \"tmux\"",
        "profile = \"power-user\"",
        "sandbox = \"workspace-write\"",
        "approval_policy = \"on-request\"",
        "daemon_owned = true",
        "allow_terminal_control = true",
        "",
        "To adopt an already-running iTerm2 or Terminal.app Codex session, also set:",
        "",
        "allow_user_owned_sessions = true",
        "backend = \"iterm2\" # or \"terminal-app\" or \"auto\"",
        "daemon_owned = false",
        "",
        "Then run: npm run bridge:ctl -- terminal status && npm run bridge:ctl -- terminal lock",
      ].join("\n"));
      return;
    default:
      throw new Error("Usage: bridgectl terminal status|use|init|start|stop|restart|lock|unlock|ping|ask|interrupt|clear|unlock-superpowers");
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "start":
      await commandStart();
      return;
    case "stop":
    case "shutdown":
      await commandStop(args);
      return;
    case "status":
      await commandStatus();
      return;
    case "capabilities":
      await commandCapabilities();
      return;
    case "terminal":
      await commandTerminal(args);
      return;
    case "gateway":
      switch (args[0]) {
        case "start":
          await commandGatewayStart();
          return;
        case "stop":
          await commandGatewayStop();
          return;
        case "status":
        case undefined:
          await commandGatewayStatus();
          return;
        default:
          usage();
      }
    case "threads": {
      const cwd = parseOptionalCwd(args);
      const limit = parseOptionalLimit(args) ?? 10;
      const threads = locator.listMatchingDesktopThreads({
        ...(cwd ? { cwd } : {}),
        limit,
      });
      if (threads.length === 0) {
        console.log("No matching desktop Codex threads.");
        return;
      }
      console.log(threads.map(thread => [
        thread.threadId,
        thread.cwd,
        thread.title ?? "(untitled)",
      ].join(" | ")).join("\n"));
      return;
    }
    case "claim-current": {
      const binding = resolveCurrentBinding(args);
      await claimBinding(binding);
      return;
    }
    case "connect": {
      const binding = resolveCurrentBinding(args);
      await claimBinding(binding);
      return;
    }
    case "claim": {
      const threadId = args[0];
      if (!threadId) {
        usage();
      }
      const binding = resolveThreadById(threadId);
      await claimBinding(binding);
      return;
    }
    case "bind-current": {
      await ensureDaemonStoppedForMutation();
      await ensureSafeMutationState();
      const binding = resolveCurrentBinding(args);
      setBinding(binding);
      const owner = parseOptionalOwner(args);
      if (owner) {
        state.setOwner(owner);
        state.setSleeping(owner !== "telegram");
      }
      console.log(`bound ${binding.threadId}`);
      return;
    }
    case "bind": {
      await ensureDaemonStoppedForMutation();
      await ensureSafeMutationState();
      const threadId = args[0];
      if (!threadId) {
        usage();
      }
      const binding = resolveThreadById(threadId);
      setBinding(binding);
      const owner = parseOptionalOwner(args);
      if (owner) {
        state.setOwner(owner);
        state.setSleeping(owner !== "telegram");
      }
      console.log(`bound ${binding.threadId}`);
      return;
    }
    case "detach":
      await ensureDaemonStoppedForMutation();
      await ensureSafeMutationState();
      setBinding(null);
      console.log("detached");
      return;
    case "mode":
      if (!args[0]) {
        console.log(getMode());
        return;
      }
      await ensureDaemonStoppedForMutation();
      await ensureSafeMutationState();
      if (!["autonomous-thread", "shared-thread-resume", "shadow-window"].includes(args[0])) {
        usage();
      }
      state.setMode(args[0] as BridgeMode);
      console.log(`mode=${args[0]}`);
      return;
    case "owner":
      if (!args[0]) {
        console.log(getOwner());
        return;
      }
      await ensureDaemonStoppedForMutation();
      if (!["telegram", "desktop", "none"].includes(args[0])) {
        usage();
      }
      state.setOwner(args[0] as BridgeOwner);
      state.setSleeping(args[0] !== "telegram");
      console.log(`owner=${args[0]}`);
      return;
    case "sleep":
      await ensureDaemonStoppedForMutation();
      state.setOwner("desktop");
      state.setSleeping(true);
      console.log("owner=desktop");
      return;
    case "wake":
      await ensureDaemonStoppedForMutation();
      state.setOwner("telegram");
      state.setSleeping(false);
      console.log("owner=telegram");
      return;
    case "call": {
      switch (args[0]) {
        case "arm":
          await commandCallArm();
          return;
        case "start":
          await commandCallStart();
          return;
        case "invite":
          await commandCallInvite(args.slice(1));
          return;
        case "disarm":
          await commandCallDisarm();
          return;
        case "hangup":
          await commandCallHangup();
          return;
        case "status":
        case undefined:
          await commandCallStatus();
          return;
        default:
          usage();
      }
    }
    case "cleanup":
      await commandCleanup(args);
      return;
    case "send":
      await commandSend(args);
      return;
    case "inbox": {
      const tasks = state.listPendingTasks(20);
      const failedTasks = state.listRecentFailedTaskRecords(10);
      if (tasks.length === 0 && failedTasks.length === 0) {
        console.log("No queued Telegram tasks.");
        return;
      }
      const sections: string[] = [];
      if (tasks.length > 0) {
        sections.push(tasks.map(task => `${task.id} ${task.kind} ${task.text}`).join("\n"));
      }
      if (failedTasks.length > 0) {
        sections.push([
          "Recent failed tasks:",
          ...failedTasks.map(failure => `${failure.task.id} ${failure.task.kind} ${failure.task.text} | error=${failure.errorText ?? "unknown"}`),
        ].join("\n"));
      }
      console.log(sections.join("\n\n"));
      return;
    }
    case "recover-queue":
      await commandRecoverQueue(args);
      return;
    case "watch":
      await commandWatch(args);
      return;
    default:
      usage();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
