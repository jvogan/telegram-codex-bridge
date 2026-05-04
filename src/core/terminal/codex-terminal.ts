import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { resolveCodexBinary, type BridgeConfig } from "../config.js";
import type { BridgeState } from "../state.js";
import type {
  TerminalLaneApprovalPolicy,
  TerminalLaneBackend,
  TerminalLaneProfile,
  TerminalLaneResolvedBackend,
  TerminalLaneSandbox,
} from "../types.js";
import { ensureDir, ensurePrivateFile } from "../util/files.js";
import {
  getItermCodexStatus,
  pingItermCodex,
  sendItermCodexControl,
  startItermCodexAsk,
  waitForItermCodexAskCompletion,
  type ItermCodexAskStart,
} from "./iterm-codex.js";
import {
  getTerminalAppCodexStatus,
  sendTerminalAppCodexControl,
} from "./terminal-app-codex.js";
import {
  getTmuxCodexOwnerNonce,
  getTmuxCodexStatus,
  pingTmuxCodex,
  sendTmuxCodexControl,
  setTmuxCodexOwner,
  startTmuxCodexAsk,
  startTmuxCodexSession,
  stopTmuxCodexSession,
  tmuxSessionExists,
  waitForTmuxCodexAskCompletion,
  type TmuxCodexAskStart,
} from "./tmux-codex.js";

export const TERMINAL_CODEX_IDENTITY_KEY = "terminal:codex_identity";
export const TERMINAL_BACKEND_OVERRIDE_KEY = "terminal:backend_override";

export interface TerminalCodexIdentity {
  backend: TerminalLaneResolvedBackend;
  tty: string | null;
  name: string;
  cwdHint: string;
  paneId: string | null;
  pid: number | null;
  command: string | null;
  profile: TerminalLaneProfile | null;
  sandbox: TerminalLaneSandbox | null;
  approvalPolicy: TerminalLaneApprovalPolicy | null;
  launcherPath: string | null;
  launchArgsHash: string | null;
  ownerNonce: string | null;
  createdAt: number | null;
  daemonOwned: boolean;
  lockedAt: number;
  lastVerifiedAt: number | null;
}

export interface TerminalCodexSession {
  backend: TerminalLaneResolvedBackend;
  tty: string | null;
  name: string;
  paneId: string | null;
  cwd: string | null;
  contents: string;
}

export interface TerminalCodexStatus {
  backend: TerminalLaneResolvedBackend;
  found: boolean;
  ready: boolean;
  session: TerminalCodexSession | null;
  blocker: string | null;
  daemonOwned: boolean;
}

export interface TerminalCodexAskStart {
  backend: TerminalLaneResolvedBackend;
  marker: string;
  session: TerminalCodexSession;
  submittedPrompt: string;
  contentsBefore: string;
  startedAt: number;
}

export interface PersistableTerminalCodexAskStart {
  backend: TerminalLaneResolvedBackend;
  marker: string;
  session: Omit<TerminalCodexSession, "contents">;
  submittedPromptHash: string;
  contentsBeforeHash: string;
  startedAt: number;
}

export interface TerminalCodexAskResult {
  marker: string;
  session: TerminalCodexSession;
  observed: boolean;
  elapsedMs: number;
  answerText: string | null;
}

export interface TerminalCodexLaunchPlan {
  command: string;
  args: string[];
  cwd: string;
  profile: TerminalLaneProfile;
  sandbox: TerminalLaneSandbox;
  approvalPolicy: TerminalLaneApprovalPolicy;
  model: string | null;
  codexProfile: string | null;
  launcherPath: string;
  launcherCommand: string;
  launchArgsHash: string;
  attachCommand: string;
}

export interface TerminalCodexPingResult {
  marker: string;
  session: TerminalCodexSession;
  observed: boolean;
  elapsedMs: number;
}

function isResolvedBackend(value: TerminalLaneBackend | null | undefined): value is TerminalLaneResolvedBackend {
  return value === "iterm2" || value === "tmux" || value === "terminal-app";
}

function terminalWorkdir(config: BridgeConfig): string {
  const configured = config.terminal_lane.workdir?.trim()
    || config.codex.workdir.trim()
    || config.repoRoot;
  return resolve(configured);
}

function directoryHint(config: BridgeConfig): string {
  return basename(terminalWorkdir(config));
}

function terminalCodexCommand(config: BridgeConfig): string {
  return config.terminal_lane.codex_command.trim() || resolveCodexBinary(config) || "codex";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function safeLauncherStem(sessionName: string): string {
  return sessionName.replace(/[^A-Za-z0-9_.-]/g, "_");
}

export function terminalAttachCommand(sessionName: string): string {
  return `tmux attach -t ${sessionName}`;
}

export function buildTerminalCodexLaunchPlan(config: BridgeConfig): TerminalCodexLaunchPlan {
  const profile = config.terminal_lane.profile;
  const sandbox = config.terminal_lane.sandbox;
  const approvalPolicy = config.terminal_lane.approval_policy;
  const cwd = terminalWorkdir(config);
  const args = [
    "-c",
    "check_for_update_on_startup=false",
    "--cd",
    cwd,
    "--sandbox",
    sandbox,
    "--ask-for-approval",
    approvalPolicy,
    "--search",
  ];
  const model = config.terminal_lane.model?.trim() || config.codex.model.trim() || undefined;
  if (model) {
    args.push("--model", model);
  }
  const reasoningEffort = config.terminal_lane.reasoning_effort?.trim();
  if (reasoningEffort) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
  }
  const codexProfile = config.terminal_lane.codex_profile?.trim() || undefined;
  if (codexProfile) {
    args.push("--profile", codexProfile);
  }
  const command = terminalCodexCommand(config);
  const launchHashPayload = JSON.stringify({
    command,
    args,
    cwd,
    profile,
  });
  const launchArgsHash = createHash("sha256").update(launchHashPayload).digest("hex");
  const launcherPath = join(
    config.storageRoot,
    "terminal",
    "launchers",
    `${safeLauncherStem(config.terminal_lane.session_name)}-${launchArgsHash.slice(0, 12)}.sh`,
  );
  return {
    command,
    args,
    cwd,
    profile,
    sandbox,
    approvalPolicy,
    model: model ?? null,
    codexProfile: codexProfile ?? null,
    launcherPath,
    launcherCommand: `/bin/sh ${shellQuote(launcherPath)}`,
    launchArgsHash,
    attachCommand: terminalAttachCommand(config.terminal_lane.session_name),
  };
}

function writeTerminalCodexLauncher(plan: TerminalCodexLaunchPlan): void {
  ensureDir(dirname(plan.launcherPath));
  const script = [
    "#!/bin/sh",
    `cd ${shellQuote(plan.cwd)} || exit 1`,
    `exec ${shellQuote(plan.command)} ${plan.args.map(shellQuote).join(" ")}`,
    "",
  ].join("\n");
  writeFileSync(plan.launcherPath, script, { mode: 0o600 });
  ensurePrivateFile(plan.launcherPath);
}

export function persistableTerminalCodexAskStart(start: TerminalCodexAskStart): PersistableTerminalCodexAskStart {
  return {
    backend: start.backend,
    marker: start.marker,
    session: {
      backend: start.session.backend,
      tty: start.session.tty,
      name: start.session.name,
      paneId: start.session.paneId,
      cwd: start.session.cwd,
    },
    submittedPromptHash: createHash("sha256").update(start.submittedPrompt).digest("hex"),
    contentsBeforeHash: createHash("sha256").update(start.contentsBefore).digest("hex"),
    startedAt: start.startedAt,
  };
}

export function terminalCodexIdentity(state: BridgeState): TerminalCodexIdentity | null {
  const raw = state.getSetting<Partial<TerminalCodexIdentity> | null>(TERMINAL_CODEX_IDENTITY_KEY, null);
  if (!raw) {
    return null;
  }
  return {
    backend: isResolvedBackend(raw.backend) ? raw.backend : "tmux",
    tty: raw.tty ?? null,
    name: raw.name ?? "telegram-codex-bridge-terminal",
    cwdHint: raw.cwdHint ?? "",
    paneId: raw.paneId ?? null,
    pid: raw.pid ?? null,
    command: raw.command ?? null,
    profile: raw.profile === "public-safe" || raw.profile === "power-user" ? raw.profile : null,
    sandbox: raw.sandbox === "read-only" || raw.sandbox === "workspace-write" ? raw.sandbox : null,
    approvalPolicy: raw.approvalPolicy === "never" || raw.approvalPolicy === "on-request" ? raw.approvalPolicy : null,
    launcherPath: raw.launcherPath ?? null,
    launchArgsHash: raw.launchArgsHash ?? null,
    ownerNonce: raw.ownerNonce ?? null,
    createdAt: raw.createdAt ?? null,
    daemonOwned: raw.daemonOwned ?? false,
    lockedAt: raw.lockedAt ?? Date.now(),
    lastVerifiedAt: raw.lastVerifiedAt ?? null,
  };
}

export function setTerminalCodexIdentity(state: BridgeState, identity: TerminalCodexIdentity | null): void {
  state.setSetting<TerminalCodexIdentity | null>(TERMINAL_CODEX_IDENTITY_KEY, identity);
}

export function getTerminalBackendOverride(state: BridgeState): TerminalLaneBackend | null {
  const value = state.getSetting<TerminalLaneBackend | null>(TERMINAL_BACKEND_OVERRIDE_KEY, null);
  return value === "auto" || isResolvedBackend(value) ? value : null;
}

export function setTerminalBackendOverride(state: BridgeState, backend: TerminalLaneBackend | null): void {
  state.setSetting<TerminalLaneBackend | null>(TERMINAL_BACKEND_OVERRIDE_KEY, backend);
}

export function sanitizeTerminalErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "Terminal automation failed.");
  const singleLine = raw
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const executionMatch = singleLine.match(/execution error:\s*(.*?)(?:\s+\(-?\d+\))?$/i);
  const compact = executionMatch?.[1]
    ? `Terminal automation failed: ${executionMatch[1]}`
    : singleLine.includes("Command failed: osascript -e")
      ? "Terminal automation command failed."
      : singleLine;
  return compact
    .replace(/\/Users\/[^/\s]+/g, "~")
    .replace(/\b(?:bot|api|launch|control|telegram)?_?token[=:]\S+/gi, "token=[redacted]")
    .replace(/\b(?:api|control|launch|client)?_?secret[=:]\S+/gi, "secret=[redacted]")
    .slice(0, 500);
}

function adaptTmuxStatus(status: Awaited<ReturnType<typeof getTmuxCodexStatus>>, daemonOwned = false): TerminalCodexStatus {
  return {
    backend: "tmux",
    found: status.found,
    ready: status.ready,
    session: status.session
      ? {
          backend: "tmux",
          tty: status.session.tty,
          name: status.session.name,
          paneId: status.session.paneId,
          cwd: status.session.cwd,
          contents: status.session.contents,
        }
      : null,
    blocker: status.blocker,
    daemonOwned,
  };
}

function adaptItermStatus(status: Awaited<ReturnType<typeof getItermCodexStatus>>, daemonOwned = false): TerminalCodexStatus {
  return {
    backend: "iterm2",
    found: status.found,
    ready: status.ready,
    session: status.session
      ? {
          backend: "iterm2",
          tty: status.session.tty,
          name: status.session.name,
          paneId: null,
          cwd: null,
          contents: status.session.contents,
        }
      : null,
    blocker: status.blocker,
    daemonOwned,
  };
}

function adaptTerminalAppStatus(status: Awaited<ReturnType<typeof getTerminalAppCodexStatus>>, daemonOwned = false): TerminalCodexStatus {
  return {
    backend: "terminal-app",
    found: status.found,
    ready: status.ready,
    session: status.session
      ? {
          backend: "terminal-app",
          tty: status.session.tty,
          name: status.session.name,
          paneId: null,
          cwd: null,
          contents: status.session.contents,
        }
      : null,
    blocker: status.blocker,
    daemonOwned,
  };
}

export function selectedTerminalBackend(
  config: BridgeConfig,
  state: BridgeState,
  options: { preferIdentity?: boolean } = {},
): TerminalLaneBackend {
  const identity = options.preferIdentity === false ? null : terminalCodexIdentity(state);
  if (identity) {
    return identity.backend;
  }
  return getTerminalBackendOverride(state) ?? config.terminal_lane.backend;
}

async function getStatusForBackend(
  config: BridgeConfig,
  state: BridgeState,
  backend: TerminalLaneResolvedBackend,
  options: { unlocked?: boolean } = {},
): Promise<TerminalCodexStatus> {
  const identity = options.unlocked ? null : terminalCodexIdentity(state);
  if (backend !== "tmux" && !config.terminal_lane.allow_user_owned_sessions) {
    return {
      backend,
      found: false,
      ready: false,
      session: null,
      blocker: "User-owned terminal sessions are gated. Set terminal_lane.allow_user_owned_sessions = true before using iTerm2 or Terminal.app.",
      daemonOwned: false,
    };
  }
  const daemonOwned = identity?.backend === backend ? identity.daemonOwned : backend === "tmux" && config.terminal_lane.daemon_owned;
  switch (backend) {
    case "iterm2":
      return adaptItermStatus(await getItermCodexStatus({
        nameContains: config.terminal_lane.session_name,
        expectedDirectoryHint: directoryHint(config),
        expectedTty: identity?.backend === "iterm2" ? identity.tty : null,
      }), daemonOwned);
    case "terminal-app":
      return adaptTerminalAppStatus(await getTerminalAppCodexStatus({
        nameContains: config.terminal_lane.session_name,
        expectedDirectoryHint: directoryHint(config),
        expectedTty: identity?.backend === "terminal-app" ? identity.tty : null,
      }), daemonOwned);
    case "tmux": {
      const status = adaptTmuxStatus(await getTmuxCodexStatus({
        sessionName: config.terminal_lane.session_name,
        expectedDirectoryHint: directoryHint(config),
        expectedPaneId: identity?.backend === "tmux" ? identity.paneId : null,
      }), daemonOwned);
      if (status.session && identity?.backend === "tmux" && identity.daemonOwned) {
        if (!identity.ownerNonce) {
          return {
            ...status,
            ready: false,
            blocker: "Locked tmux terminal lane is missing its bridge owner nonce.",
          };
        }
        const ownerNonce = await getTmuxCodexOwnerNonce(status.session.name);
        if (ownerNonce !== identity.ownerNonce) {
          return {
            ...status,
            ready: false,
            blocker: "Locked tmux terminal lane owner nonce no longer matches bridge state.",
          };
        }
      }
      return status;
    }
  }
}

export async function getTerminalCodexStatus(
  config: BridgeConfig,
  state: BridgeState,
  options: { unlocked?: boolean } = {},
): Promise<TerminalCodexStatus> {
  if (!config.terminal_lane.enabled) {
    return {
      backend: "tmux",
      found: false,
      ready: false,
      session: null,
      blocker: "Terminal lane is disabled in bridge.config.toml.",
      daemonOwned: false,
    };
  }
  const selected = selectedTerminalBackend(config, state);
  if (isResolvedBackend(selected)) {
    return await getStatusForBackend(config, state, selected, options);
  }
  const identity = terminalCodexIdentity(state);
  if (identity) {
    return await getStatusForBackend(config, state, identity.backend, options);
  }
  const failures: string[] = [];
  const backends: TerminalLaneResolvedBackend[] = config.terminal_lane.allow_user_owned_sessions
    ? ["tmux", "iterm2", "terminal-app"]
    : ["tmux"];
  for (const backend of backends) {
    const status = await getStatusForBackend(config, state, backend, { unlocked: true }).catch(error => ({
      backend,
      found: false,
      ready: false,
      session: null,
      blocker: sanitizeTerminalErrorText(error),
      daemonOwned: false,
    }) satisfies TerminalCodexStatus);
    if (status.ready || status.found) {
      return status;
    }
    if (status.blocker) {
      failures.push(`${backend}: ${status.blocker}`);
    }
  }
  return {
    backend: "tmux",
    found: false,
    ready: false,
    session: null,
    blocker: failures.join(" | ") || "No terminal Codex lane backend found.",
    daemonOwned: false,
  };
}

export async function lockTerminalCodexIdentity(config: BridgeConfig, state: BridgeState): Promise<TerminalCodexIdentity> {
  const status = await getTerminalCodexStatus(config, state, { unlocked: true });
  if (!status.session || !status.ready) {
    throw new Error(status.blocker ?? "No ready Codex CLI session was found to lock.");
  }
  if (!config.terminal_lane.allow_user_owned_sessions) {
    throw new Error("User-owned terminal sessions are gated. Set terminal_lane.allow_user_owned_sessions = true before locking an existing terminal session.");
  }
  const identity: TerminalCodexIdentity = {
    backend: status.backend,
    tty: status.session.tty,
    name: status.session.name,
    cwdHint: directoryHint(config),
    paneId: status.session.paneId,
    pid: null,
    command: config.terminal_lane.codex_command || null,
    profile: null,
    sandbox: null,
    approvalPolicy: null,
    launcherPath: null,
    launchArgsHash: null,
    ownerNonce: null,
    createdAt: null,
    daemonOwned: false,
    lockedAt: Date.now(),
    lastVerifiedAt: Date.now(),
  };
  setTerminalCodexIdentity(state, identity);
  return identity;
}

export async function ensureTerminalCodexIdentity(config: BridgeConfig, state: BridgeState): Promise<TerminalCodexIdentity> {
  const existing = terminalCodexIdentity(state);
  if (existing) {
    const status = await getTerminalCodexStatus(config, state);
    if (status.ready && status.session) {
      const next = {
        ...existing,
        lastVerifiedAt: Date.now(),
      };
      setTerminalCodexIdentity(state, next);
      return next;
    }
    throw new Error(status.blocker ?? "Locked terminal Codex lane is no longer ready.");
  }
  const selected = selectedTerminalBackend(config, state, { preferIdentity: false });
  if (selected === "tmux" || selected === "auto") {
    return await startTerminalCodexWorker(config, state);
  }
  return await lockTerminalCodexIdentity(config, state);
}

export async function startTerminalCodexWorker(
  config: BridgeConfig,
  state: BridgeState,
): Promise<TerminalCodexIdentity> {
  if (!config.terminal_lane.enabled) {
    throw new Error("Terminal lane is disabled in bridge.config.toml.");
  }
  const selected = selectedTerminalBackend(config, state, { preferIdentity: false });
  const backend = selected === "auto" ? "tmux" : selected;
  if (backend !== "tmux") {
    throw new Error("Bridge-owned terminal worker start is only supported for tmux. Enable terminal_lane.allow_user_owned_sessions and use `terminal lock` for iTerm2 or Terminal.app sessions.");
  }
  if (!config.terminal_lane.daemon_owned) {
    throw new Error("Bridge-owned tmux start requires terminal_lane.daemon_owned = true. Use `terminal lock` for user-owned sessions.");
  }
  const existingIdentity = terminalCodexIdentity(state);
  const existingStatus = await getStatusForBackend(config, state, "tmux", { unlocked: true });
  const exactSessionExists = await tmuxSessionExists(config.terminal_lane.session_name);
  if (existingStatus.session) {
    const ownerNonce = await getTmuxCodexOwnerNonce(existingStatus.session.name);
    if (
      existingIdentity?.daemonOwned
      && existingIdentity.ownerNonce
      && ownerNonce === existingIdentity.ownerNonce
    ) {
      const refreshed: TerminalCodexIdentity = {
        ...existingIdentity,
        tty: existingStatus.session.tty,
        name: existingStatus.session.name,
        paneId: existingStatus.session.paneId,
        cwdHint: directoryHint(config),
        lastVerifiedAt: existingStatus.ready ? Date.now() : existingIdentity.lastVerifiedAt,
      };
      setTerminalCodexIdentity(state, refreshed);
      return refreshed;
    }
    throw new Error("A matching tmux Codex session already exists but does not carry this bridge's owner nonce; refusing to claim or send into it.");
  }
  if (exactSessionExists) {
    throw new Error("A tmux session with the configured terminal lane name already exists but is not a verified bridge-owned Codex lane; refusing to claim it.");
  }
  if (existingStatus.blocker && /multiple matching/i.test(existingStatus.blocker)) {
    throw new Error(existingStatus.blocker);
  }
  const launchPlan = buildTerminalCodexLaunchPlan(config);
  writeTerminalCodexLauncher(launchPlan);
  const ownerNonce = randomUUID();
  let tmuxStarted = false;
  let ownerRecorded = false;
  let status: TerminalCodexStatus;
  try {
    await startTmuxCodexSession({
      sessionName: config.terminal_lane.session_name,
      cwd: launchPlan.cwd,
      shellCommand: launchPlan.launcherCommand,
    });
    tmuxStarted = true;
    await setTmuxCodexOwner(config.terminal_lane.session_name, ownerNonce, launchPlan.launchArgsHash);
    ownerRecorded = true;
    const deadline = Date.now() + 30_000;
    status = await getStatusForBackend(config, state, "tmux", { unlocked: true });
    while (!status.session && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 500));
      status = await getStatusForBackend(config, state, "tmux", { unlocked: true });
    }
    if (!status.session) {
      throw new Error(status.blocker ?? "tmux Codex worker started but could not be verified.");
    }
  } catch (error) {
    if (tmuxStarted) {
      await stopTmuxCodexSession(
        config.terminal_lane.session_name,
        ownerRecorded ? { ownerNonce } : {},
      ).catch(() => undefined);
    }
    throw error;
  }
  const identity: TerminalCodexIdentity = {
    backend: "tmux",
    tty: status.session.tty,
    name: status.session.name,
    cwdHint: directoryHint(config),
    paneId: status.session.paneId,
    pid: null,
    command: launchPlan.command,
    profile: launchPlan.profile,
    sandbox: launchPlan.sandbox,
    approvalPolicy: launchPlan.approvalPolicy,
    launcherPath: launchPlan.launcherPath,
    launchArgsHash: launchPlan.launchArgsHash,
    ownerNonce,
    createdAt: Date.now(),
    daemonOwned: true,
    lockedAt: Date.now(),
    lastVerifiedAt: status.ready ? Date.now() : null,
  };
  setTerminalCodexIdentity(state, identity);
  return identity;
}

export async function stopTerminalCodexWorker(config: BridgeConfig, state: BridgeState): Promise<boolean> {
  const identity = terminalCodexIdentity(state);
  if (!identity) {
    return false;
  }
  if (!identity.daemonOwned) {
    return false;
  }
  const sessionName = identity.name || config.terminal_lane.session_name;
  if (!await tmuxSessionExists(sessionName)) {
    setTerminalCodexIdentity(state, null);
    return false;
  }
  if (!identity.ownerNonce) {
    throw new Error("Refusing to stop daemon-owned tmux worker because its owner nonce is missing from bridge state.");
  }
  try {
    await stopTmuxCodexSession(sessionName, {
      ownerNonce: identity.ownerNonce,
    });
  } catch (error) {
    const message = sanitizeTerminalErrorText(error);
    if (!/can't find session|no server running|session not found/i.test(message)) {
      throw new Error(message);
    }
  }
  setTerminalCodexIdentity(state, null);
  return true;
}

export async function pingTerminalCodex(
  config: BridgeConfig,
  state: BridgeState,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<TerminalCodexPingResult> {
  const identity = await ensureTerminalCodexIdentity(config, state);
  switch (identity.backend) {
    case "tmux": {
      const result = await pingTmuxCodex({
        sessionName: config.terminal_lane.session_name,
        expectedDirectoryHint: directoryHint(config),
        expectedPaneId: identity.paneId ?? null,
      }, options);
      return {
        ...result,
        session: {
          backend: "tmux",
          tty: result.session.tty,
          name: result.session.name,
          paneId: result.session.paneId,
          cwd: result.session.cwd,
          contents: result.session.contents,
        },
      };
    }
    case "iterm2": {
      const result = await pingItermCodex({
        nameContains: config.terminal_lane.session_name,
        expectedDirectoryHint: directoryHint(config),
        expectedTty: identity.tty,
      }, options);
      return {
        ...result,
        session: {
          backend: "iterm2",
          tty: result.session.tty,
          name: result.session.name,
          paneId: null,
          cwd: null,
          contents: result.session.contents,
        },
      };
    }
    case "terminal-app":
      throw new Error("Terminal.app terminal lane ping is attach/status-only; use iTerm2 or tmux for ping/control.");
  }
}

function itermAskStart(start: TerminalCodexAskStart): ItermCodexAskStart {
  if (!start.session.tty) {
    throw new Error("iTerm2 terminal lane ask is missing its TTY.");
  }
  return {
    marker: start.marker,
    session: {
      tty: start.session.tty,
      name: start.session.name,
      contents: start.session.contents,
    },
    submittedPrompt: start.submittedPrompt,
    contentsBefore: start.contentsBefore,
    startedAt: start.startedAt,
  };
}

function tmuxAskStart(start: TerminalCodexAskStart): TmuxCodexAskStart {
  if (!start.session.paneId || !start.session.tty) {
    throw new Error("tmux terminal lane ask is missing its pane identity.");
  }
  return {
    marker: start.marker,
    session: {
      paneId: start.session.paneId,
      tty: start.session.tty,
      name: start.session.name,
      cwd: start.session.cwd,
      contents: start.session.contents,
    },
    submittedPrompt: start.submittedPrompt,
    contentsBefore: start.contentsBefore,
    startedAt: start.startedAt,
  };
}

export async function startTerminalCodexAsk(
  prompt: string,
  config: BridgeConfig,
  state: BridgeState,
): Promise<TerminalCodexAskStart> {
  const identity = await ensureTerminalCodexIdentity(config, state);
  switch (identity.backend) {
    case "tmux": {
      const start = await startTmuxCodexAsk(prompt, {
        sessionName: config.terminal_lane.session_name,
        expectedDirectoryHint: directoryHint(config),
        expectedPaneId: identity.paneId ?? null,
      });
      return {
        backend: "tmux",
        marker: start.marker,
        session: {
          backend: "tmux",
          tty: start.session.tty,
          name: start.session.name,
          paneId: start.session.paneId,
          cwd: start.session.cwd,
          contents: start.session.contents,
        },
        submittedPrompt: start.submittedPrompt,
        contentsBefore: start.contentsBefore,
        startedAt: start.startedAt,
      };
    }
    case "iterm2": {
      const start = await startItermCodexAsk(prompt, {
        nameContains: config.terminal_lane.session_name,
        expectedDirectoryHint: directoryHint(config),
        expectedTty: identity.tty,
      });
      return {
        backend: "iterm2",
        marker: start.marker,
        session: {
          backend: "iterm2",
          tty: start.session.tty,
          name: start.session.name,
          paneId: null,
          cwd: null,
          contents: start.session.contents,
        },
        submittedPrompt: start.submittedPrompt,
        contentsBefore: start.contentsBefore,
        startedAt: start.startedAt,
      };
    }
    case "terminal-app":
      throw new Error("Terminal.app ask relay is attach/status-only; use iTerm2 or tmux for /terminal ask.");
  }
}

export async function waitForTerminalCodexAskCompletion(
  started: TerminalCodexAskStart,
  config: BridgeConfig,
  state: BridgeState,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<TerminalCodexAskResult> {
  const identity = terminalCodexIdentity(state);
  switch (started.backend) {
    case "tmux": {
      const result = await waitForTmuxCodexAskCompletion(tmuxAskStart(started), {
        sessionName: config.terminal_lane.session_name,
        expectedDirectoryHint: directoryHint(config),
        expectedPaneId: identity?.backend === "tmux" ? identity.paneId : started.session.paneId,
      }, options);
      return {
        ...result,
        session: {
          backend: "tmux",
          tty: result.session.tty,
          name: result.session.name,
          paneId: result.session.paneId,
          cwd: result.session.cwd,
          contents: result.session.contents,
        },
      };
    }
    case "iterm2": {
      const result = await waitForItermCodexAskCompletion(itermAskStart(started), {
        nameContains: config.terminal_lane.session_name,
        expectedDirectoryHint: directoryHint(config),
        expectedTty: identity?.backend === "iterm2" ? identity.tty : started.session.tty,
      }, options);
      return {
        ...result,
        session: {
          backend: "iterm2",
          tty: result.session.tty,
          name: result.session.name,
          paneId: null,
          cwd: null,
          contents: result.session.contents,
        },
      };
    }
    case "terminal-app":
      throw new Error("Terminal.app ask relay is attach/status-only; use iTerm2 or tmux for /terminal ask.");
  }
}

export async function sendTerminalCodexControl(
  control: "interrupt" | "clear",
  config: BridgeConfig,
  state: BridgeState,
): Promise<TerminalCodexSession> {
  if (!config.terminal_lane.allow_terminal_control) {
    throw new Error("Terminal control is gated. Set terminal_lane.allow_terminal_control = true before sending interrupt or clear.");
  }
  const identity = await ensureTerminalCodexIdentity(config, state);
  switch (identity.backend) {
    case "tmux": {
      const session = await sendTmuxCodexControl(control, {
        sessionName: config.terminal_lane.session_name,
        expectedDirectoryHint: directoryHint(config),
        expectedPaneId: identity.paneId ?? null,
      });
      return {
        backend: "tmux",
        tty: session.tty,
        name: session.name,
        paneId: session.paneId,
        cwd: session.cwd,
        contents: session.contents,
      };
    }
    case "iterm2": {
      const session = await sendItermCodexControl(control, {
        nameContains: config.terminal_lane.session_name,
        expectedDirectoryHint: directoryHint(config),
        expectedTty: identity.tty,
      });
      return {
        backend: "iterm2",
        tty: session.tty,
        name: session.name,
        paneId: null,
        cwd: null,
        contents: session.contents,
      };
    }
    case "terminal-app": {
      const session = await sendTerminalAppCodexControl(control, {
        nameContains: config.terminal_lane.session_name,
        expectedDirectoryHint: directoryHint(config),
        expectedTty: identity.tty,
      });
      return {
        backend: "terminal-app",
        tty: session.tty,
        name: session.name,
        paneId: null,
        cwd: null,
        contents: session.contents,
      };
    }
  }
}

export function renderTerminalCodexStatus(status: TerminalCodexStatus, identity: TerminalCodexIdentity | null): string {
  if (!status.session) {
    return [
      "Terminal Codex lane",
      `Backend: ${status.backend}`,
      "Found: no",
      `Locked: ${identity ? "yes" : "no"}`,
      identity ? `Daemon-owned: ${identity.daemonOwned ? "yes" : "no"}` : null,
      identity?.profile ? `Profile: ${identity.profile}` : null,
      identity?.sandbox ? `Sandbox: ${identity.sandbox}` : null,
      identity?.approvalPolicy ? `Approvals: ${identity.approvalPolicy}` : null,
      (identity?.backend ?? status.backend) === "tmux" ? `Attach: ${terminalAttachCommand(identity?.name || "telegram-codex-bridge-terminal")}` : null,
      `Blocker: ${status.blocker ?? "unknown"}`,
    ].filter(Boolean).join("\n");
  }
  return [
    "Terminal Codex lane",
    `Backend: ${status.backend}`,
    "Found: yes",
    `Ready: ${status.ready ? "yes" : "no"}`,
    `Session: ${status.session.name}`,
    `TTY: ${status.session.tty ?? "none"}`,
    status.session.paneId ? `Pane: ${status.session.paneId}` : null,
    status.session.cwd ? `CWD: ${status.session.cwd}` : null,
    `Locked: ${identity ? "yes" : "no"}`,
    `Daemon-owned: ${(identity?.daemonOwned ?? status.daemonOwned) ? "yes" : "no"}`,
    identity?.profile ? `Profile: ${identity.profile}` : null,
    identity?.sandbox ? `Sandbox: ${identity.sandbox}` : null,
    identity?.approvalPolicy ? `Approvals: ${identity.approvalPolicy}` : null,
    status.backend === "tmux" ? `Attach: ${terminalAttachCommand(status.session.name)}` : null,
    `Blocker: ${status.blocker ?? "none"}`,
  ].filter(Boolean).join("\n");
}
