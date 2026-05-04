import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { resolveFallbackLaneConfig, type BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { BridgeState } from "../state.js";
import type { BackendStatus, BoundThread, BridgeLane, BridgeMode } from "../types.js";
import type { JsonRpcId, JsonRpcRequest, TurnResult } from "./protocol.js";
import { CodexAppServerClient } from "./client.js";
import { RolloutWatcher } from "../desktop/rollout-watcher.js";

export interface CodexInputText {
  type: "text";
  text: string;
}

export interface CodexInputLocalImage {
  type: "localImage";
  path: string;
}

export type CodexTurnInput = CodexInputText | CodexInputLocalImage;

export interface BridgeTurnStartedEvent {
  turnId: string | null;
  threadId: string | null;
}

export interface BridgeTurnFinalTextEvent {
  turnId: string | null;
  threadId: string | null;
  text: string;
}

export interface BridgeBackendUnavailableEvent {
  reason: "app_server_exit" | "app_server_socket_closed";
  detail: string | null;
}

export interface BridgeBackend {
  readonly mode: BridgeMode;
  start(): Promise<void>;
  close(): Promise<void>;
  startTurn(input: CodexTurnInput[]): Promise<TurnResult>;
  interruptActiveTurn(): Promise<void>;
  respondToServerRequest(requestId: JsonRpcId, payload: unknown): Promise<void>;
  rejectServerRequest(requestId: JsonRpcId, message: string): Promise<void>;
  onServerRequest(handler: (request: JsonRpcRequest) => void): void;
  onTurnStarted(handler: (event: BridgeTurnStartedEvent) => void): void;
  onTurnFinalText(handler: (event: BridgeTurnFinalTextEvent) => void): void;
  onUnavailable(handler: (event: BridgeBackendUnavailableEvent) => void): void;
  getThreadId(): string | null;
  getBoundThread(): BoundThread | null;
  getExecutionCwd(): string | null;
  supportsResetThread(): boolean;
  resetThread(): Promise<string>;
  canRelayApprovals(): boolean;
  hasActiveTurn(): boolean;
  isAvailable(): boolean;
  getStatus(): BackendStatus;
}

interface PendingTurn {
  startedAt: number;
  turnId: string | null;
  finalMessages: string[];
  fallbackMessages: string[];
  resolve(result: TurnResult): void;
  reject(error: Error): void;
}

export interface AppServerBackendOptions {
  lane?: BridgeLane;
  appServerPort?: number;
  autonomousThreadStateKey?: string;
  workdir?: string;
}

export interface ResolvedAppServerBackendOptions {
  lane: BridgeLane;
  appServerPort: number;
  autonomousThreadStateKey: string;
  workdir: string;
  sandbox: BridgeConfig["codex"]["sandbox"];
}

export function autonomousThreadStateKeyForLane(lane: BridgeLane): string {
  return lane === "primary" ? "codex:thread_id" : "codex:fallback_thread_id";
}

export function resolveAppServerBackendOptions(
  config: BridgeConfig,
  options: AppServerBackendOptions = {},
): ResolvedAppServerBackendOptions {
  const lane = options.lane ?? "primary";
  const fallbackLane = resolveFallbackLaneConfig(config);
  const fallbackWorkdir = fallbackLane.workdir ?? config.codex.workdir;
  return {
    lane,
    appServerPort: options.appServerPort
      ?? (lane === "fallback" ? fallbackLane.app_server_port : config.codex.app_server_port),
    autonomousThreadStateKey: options.autonomousThreadStateKey ?? autonomousThreadStateKeyForLane(lane),
    workdir: options.workdir ?? (lane === "fallback" ? fallbackWorkdir : config.codex.workdir),
    sandbox: lane === "fallback" && !fallbackLane.allow_workspace_writes ? "read-only" : config.codex.sandbox,
  };
}

function mediaMcpArgs(config: BridgeConfig): { command: string; args: string[]; cwd: string } {
  const builtPath = join(config.repoRoot, "dist", "bin", "media-mcp.js");
  const sourcePath = join(config.repoRoot, "src", "bin", "media-mcp.ts");
  const tsxCliPath = join(config.repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const useBuiltMcp = existsSync(builtPath);
  const command = process.execPath;
  const args = useBuiltMcp
    ? [builtPath]
    : existsSync(tsxCliPath)
      ? [tsxCliPath, sourcePath]
      : [builtPath];
  return { command, args, cwd: config.repoRoot };
}

function buildAppServerArgs(config: BridgeConfig, options: ResolvedAppServerBackendOptions): string[] {
  const mcp = mediaMcpArgs(config);
  return [
    "app-server",
    "--listen",
    `ws://127.0.0.1:${options.appServerPort}`,
    "-c",
    `mcp_servers.telegram_codex_bridge_media.command="${mcp.command}"`,
    "-c",
    `mcp_servers.telegram_codex_bridge_media.args=${JSON.stringify(mcp.args)}`,
    "-c",
    `mcp_servers.telegram_codex_bridge_media.cwd="${mcp.cwd}"`,
  ];
}

abstract class AppServerBackend extends EventEmitter implements BridgeBackend {
  protected readonly client: CodexAppServerClient;
  protected threadId: string | null = null;
  protected pendingTurn: PendingTurn | null = null;
  private closing = false;

  abstract readonly mode: BridgeMode;

  constructor(
    protected readonly config: BridgeConfig,
    protected readonly state: BridgeState,
    protected readonly logger: Logger,
    protected readonly backendOptions: ResolvedAppServerBackendOptions = resolveAppServerBackendOptions(config),
  ) {
    super();
    this.client = new CodexAppServerClient(config.bridge.codex_binary, buildAppServerArgs(config, this.backendOptions), logger);
    this.client.on("notification", notification => this.handleNotification(notification as { method: string; params?: any }));
    this.client.on("serverRequest", request => this.emit("serverRequest", request));
    this.client.on("exit", code => {
      if (this.closing) {
        return;
      }
      this.emit("unavailable", {
        reason: "app_server_exit",
        detail: code === null ? null : String(code),
      } satisfies BridgeBackendUnavailableEvent);
    });
    this.client.on("close", () => {
      if (this.closing) {
        return;
      }
      this.emit("unavailable", {
        reason: "app_server_socket_closed",
        detail: null,
      } satisfies BridgeBackendUnavailableEvent);
    });
  }

  async start(): Promise<void> {
    await this.client.start();
    await this.client.connect(`ws://127.0.0.1:${this.backendOptions.appServerPort}`);
    await this.client.request("initialize", {
      protocolVersion: 1,
      capabilities: { experimentalApi: true },
      clientInfo: { name: "telegram-codex-bridge", version: "0.2.0" },
    });
    await this.initializeThread();
  }

  async close(): Promise<void> {
    this.closing = true;
    try {
      await this.client.close();
    } finally {
      this.closing = false;
    }
  }

  async startTurn(input: CodexTurnInput[]): Promise<TurnResult> {
    if (!this.threadId) {
      throw new Error("Codex thread is not ready.");
    }
    if (this.pendingTurn) {
      throw new Error("A Codex turn is already in progress.");
    }
    return new Promise<TurnResult>((resolve, reject) => {
      this.pendingTurn = {
        startedAt: Date.now(),
        turnId: null,
        finalMessages: [],
        fallbackMessages: [],
        resolve,
        reject,
      };
      this.client.request<{ turn: { id: string } }>("turn/start", {
        threadId: this.threadId,
        input: input.map(entry => {
          if (entry.type === "text") {
            return { type: "text", text: entry.text, text_elements: [] };
          }
          return entry;
        }),
      }).then(result => {
        if (this.pendingTurn) {
          this.pendingTurn.turnId = result.turn.id;
        }
        this.emit("turnStarted", {
          turnId: result.turn.id,
          threadId: this.threadId,
        } satisfies BridgeTurnStartedEvent);
      }).catch(error => {
        const pending = this.pendingTurn;
        this.pendingTurn = null;
        pending?.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async interruptActiveTurn(): Promise<void> {
    if (!this.threadId || !this.pendingTurn) {
      return;
    }
    await this.client.request("turn/interrupt", {
      threadId: this.threadId,
      turnId: this.pendingTurn.turnId,
    });
  }

  async respondToServerRequest(requestId: JsonRpcId, payload: unknown): Promise<void> {
    await this.client.respond(requestId, payload);
  }

  async rejectServerRequest(requestId: JsonRpcId, message: string): Promise<void> {
    await this.client.respondError(requestId, message);
  }

  onServerRequest(handler: (request: JsonRpcRequest) => void): void {
    this.on("serverRequest", handler);
  }

  onTurnStarted(handler: (event: BridgeTurnStartedEvent) => void): void {
    this.on("turnStarted", handler);
  }

  onTurnFinalText(handler: (event: BridgeTurnFinalTextEvent) => void): void {
    this.on("turnFinalText", handler);
  }

  onUnavailable(handler: (event: BridgeBackendUnavailableEvent) => void): void {
    this.on("unavailable", handler);
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  getBoundThread(): BoundThread | null {
    return null;
  }

  getExecutionCwd(): string | null {
    return null;
  }

  supportsResetThread(): boolean {
    return false;
  }

  async resetThread(): Promise<string> {
    throw new Error(`${this.mode} does not support resetting the active thread.`);
  }

  canRelayApprovals(): boolean {
    return true;
  }

  hasActiveTurn(): boolean {
    return this.pendingTurn !== null;
  }

  isAvailable(): boolean {
    return this.client.isConnected() && this.threadId !== null;
  }

  getStatus(): BackendStatus {
    return {
      mode: this.mode,
      threadId: this.threadId,
      cwd: this.getExecutionCwd(),
      binding: this.getBoundThread(),
      supportsReset: this.supportsResetThread(),
      supportsApprovals: this.canRelayApprovals(),
    };
  }

  protected abstract initializeThread(): Promise<void>;

  protected handleNotification(notification: { method: string; params?: any }): void {
    const pending = this.pendingTurn;
    if (!pending) {
      return;
    }
    switch (notification.method) {
      case "item/completed": {
        const item = notification.params?.item;
        if (item?.type === "agentMessage" && typeof item.text === "string") {
          pending.fallbackMessages.push(item.text);
          if (item.phase === "final_answer") {
            pending.finalMessages.push(item.text);
            this.emit("turnFinalText", {
              turnId: pending.turnId,
              threadId: this.threadId,
              text: pending.finalMessages.join("\n\n"),
            } satisfies BridgeTurnFinalTextEvent);
          }
        }
        break;
      }
      case "turn/completed": {
        const result: TurnResult = {
          turnId: pending.turnId ?? randomUUID(),
          startedAt: pending.startedAt,
          completedAt: Date.now(),
          finalText: pending.finalMessages.length > 0
            ? pending.finalMessages.join("\n\n")
            : pending.fallbackMessages.at(-1) ?? "",
        };
        this.pendingTurn = null;
        pending.resolve(result);
        break;
      }
      default:
        break;
    }
  }
}

export class AutonomousThreadBackend extends AppServerBackend {
  readonly mode = "autonomous-thread" as const;

  protected override async initializeThread(): Promise<void> {
    if (!this.backendOptions.workdir) {
      throw new Error("codex.workdir is required in autonomous-thread mode.");
    }
    const existingThreadId = this.state.getSetting<string | null>(this.backendOptions.autonomousThreadStateKey, null);
    if (existingThreadId) {
      try {
        await this.client.request("thread/resume", {
          threadId: existingThreadId,
          persistExtendedHistory: true,
          cwd: this.backendOptions.workdir,
          approvalPolicy: this.config.codex.approval_policy,
          sandbox: this.backendOptions.sandbox,
        });
        this.threadId = existingThreadId;
        return;
      } catch (error) {
        this.logger.warn("failed to resume thread, starting a new one", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await this.createFreshThread();
  }

  override getExecutionCwd(): string | null {
    return this.backendOptions.workdir || null;
  }

  override supportsResetThread(): boolean {
    return true;
  }

  override async resetThread(): Promise<string> {
    return this.createFreshThread();
  }

  private async createFreshThread(): Promise<string> {
    const created = await this.client.request<{ thread: { id: string } }>("thread/start", {
      cwd: this.backendOptions.workdir,
      approvalPolicy: this.config.codex.approval_policy,
      sandbox: this.backendOptions.sandbox,
      ephemeral: false,
      experimentalRawEvents: false,
      persistExtendedHistory: true,
      ...(this.config.codex.model ? { model: this.config.codex.model } : {}),
    });
    this.threadId = created.thread.id;
    this.state.setSetting(this.backendOptions.autonomousThreadStateKey, this.threadId);
    return this.threadId;
  }
}

export class SharedThreadBackend extends AppServerBackend {
  readonly mode = "shared-thread-resume" as const;

  constructor(
    config: BridgeConfig,
    state: BridgeState,
    logger: Logger,
    private readonly boundThread: BoundThread,
    backendOptions?: ResolvedAppServerBackendOptions,
  ) {
    super(config, state, logger, backendOptions);
  }

  protected override async initializeThread(): Promise<void> {
    await this.client.request("thread/resume", {
      threadId: this.boundThread.threadId,
      persistExtendedHistory: true,
      cwd: this.boundThread.cwd,
      approvalPolicy: this.config.codex.approval_policy,
      sandbox: this.config.codex.sandbox,
    });
    this.threadId = this.boundThread.threadId;
  }

  override getBoundThread(): BoundThread | null {
    return this.boundThread;
  }

  override getExecutionCwd(): string | null {
    return this.boundThread.cwd;
  }
}

async function copyTextToClipboard(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", code => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr || `pbcopy exited with code ${code}`));
    });
    child.stdin.end(text);
  });
}

async function runAppleScript(lines: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const args = lines.flatMap(line => ["-e", line]);
    const child = spawn("osascript", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", code => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr || `osascript exited with code ${code}`));
    });
  });
}

export class ShadowWindowBackend extends EventEmitter implements BridgeBackend {
  readonly mode = "shadow-window" as const;
  private activeTurn = false;

  constructor(
    private readonly config: BridgeConfig,
    private readonly boundThread: BoundThread,
  ) {
    super();
  }

  async start(): Promise<void> {
    if (!this.config.experimental.enable_shadow_window) {
      throw new Error("shadow-window mode is disabled. Set experimental.enable_shadow_window = true first.");
    }
    if (!existsSync(this.boundThread.rolloutPath)) {
      throw new Error(`Bound rollout file does not exist: ${this.boundThread.rolloutPath}`);
    }
    await runAppleScript(['tell application "System Events" to count processes']);
  }

  async close(): Promise<void> {}

  async startTurn(input: CodexTurnInput[]): Promise<TurnResult> {
    if (this.activeTurn) {
      throw new Error("A shadow-window turn is already in progress.");
    }
    const textBlocks: string[] = [];
    for (const entry of input) {
      if (entry.type === "text") {
        textBlocks.push(entry.text);
        continue;
      }
      textBlocks.push(`![telegram-image](${entry.path})`);
    }
    const prompt = textBlocks.join("\n\n").trim();
    if (!prompt) {
      throw new Error("shadow-window mode requires text input.");
    }
    this.activeTurn = true;
    const startedAt = Date.now();
    const watcher = new RolloutWatcher();
    try {
      await copyTextToClipboard(prompt);
      await runAppleScript([
        'tell application "Codex" to activate',
        "delay 0.2",
        'tell application "System Events"',
        'keystroke "v" using command down',
        "delay 0.1",
        "key code 36",
        "end tell",
      ]);
      this.emit("turnStarted", {
        turnId: null,
        threadId: this.boundThread.threadId,
      } satisfies BridgeTurnStartedEvent);
      return await watcher.waitForTurnResult(this.boundThread.rolloutPath, startedAt);
    } finally {
      this.activeTurn = false;
    }
  }

  async interruptActiveTurn(): Promise<void> {
    if (!this.activeTurn) {
      return;
    }
    await runAppleScript([
      'tell application "Codex" to activate',
      "delay 0.1",
      'tell application "System Events" to key code 53',
    ]);
  }

  async respondToServerRequest(): Promise<void> {
    throw new Error("shadow-window mode does not support Telegram approval relay.");
  }

  async rejectServerRequest(): Promise<void> {
    throw new Error("shadow-window mode does not support Telegram approval relay.");
  }

  onServerRequest(handler: (request: JsonRpcRequest) => void): void {
    this.on("serverRequest", handler);
  }

  onTurnStarted(handler: (event: BridgeTurnStartedEvent) => void): void {
    this.on("turnStarted", handler);
  }

  onTurnFinalText(handler: (event: BridgeTurnFinalTextEvent) => void): void {
    this.on("turnFinalText", handler);
  }

  onUnavailable(handler: (event: BridgeBackendUnavailableEvent) => void): void {
    this.on("unavailable", handler);
  }

  getThreadId(): string | null {
    return this.boundThread.threadId;
  }

  getBoundThread(): BoundThread | null {
    return this.boundThread;
  }

  getExecutionCwd(): string | null {
    return this.boundThread.cwd;
  }

  supportsResetThread(): boolean {
    return false;
  }

  async resetThread(): Promise<string> {
    throw new Error("shadow-window mode does not support thread reset from Telegram.");
  }

  canRelayApprovals(): boolean {
    return false;
  }

  hasActiveTurn(): boolean {
    return this.activeTurn;
  }

  isAvailable(): boolean {
    return true;
  }

  getStatus(): BackendStatus {
    return {
      mode: this.mode,
      threadId: this.boundThread.threadId,
      cwd: this.boundThread.cwd,
      binding: this.boundThread,
      supportsReset: false,
      supportsApprovals: false,
    };
  }
}
