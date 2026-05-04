import { EventEmitter } from "node:events";
import { Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

import { defaultBridgeMode, type BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { BridgeState } from "../state.js";
import type { ActiveTaskRecord, BackendStatus, BoundThread, BridgeLane, BridgeMode, BridgeOwner } from "../types.js";
import type { JsonRpcRequest } from "./protocol.js";
import {
  AutonomousThreadBackend,
  type AppServerBackendOptions,
  type BridgeBackendUnavailableEvent,
  type BridgeBackend,
  type BridgeTurnFinalTextEvent,
  type BridgeTurnStartedEvent,
  type CodexTurnInput,
  type ResolvedAppServerBackendOptions,
  resolveAppServerBackendOptions,
  SharedThreadBackend,
  ShadowWindowBackend,
} from "./session.js";

function backendSignature(mode: BridgeMode, boundThread: BoundThread | null): string {
  return JSON.stringify({
    mode,
    binding: boundThread
      ? {
        threadId: boundThread.threadId,
        cwd: boundThread.cwd,
        rolloutPath: boundThread.rolloutPath,
      }
      : null,
  });
}

function modeUsesAppServer(mode: BridgeMode): boolean {
  return mode !== "shadow-window";
}

async function isPortListening(port: number): Promise<boolean> {
  return await new Promise<boolean>(resolve => {
    const socket = new Socket();
    const finish = (value: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(250);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, "127.0.0.1");
  });
}

async function waitForPortClosed(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await isPortListening(port)) {
      return;
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for app-server port ${port} to close.`);
}

interface BridgeBackendManagerOptions {
  lane?: BridgeLane;
  forcedMode?: BridgeMode;
  appServerPort?: number;
  autonomousThreadStateKey?: string;
  workdir?: string;
  createBackend?: (
    mode: BridgeMode,
    boundThread: BoundThread | null,
    backendOptions: ResolvedAppServerBackendOptions,
  ) => BridgeBackend;
  waitForPortClosed?: (port: number, timeoutMs?: number) => Promise<void>;
}

export class BridgeBackendManager extends EventEmitter {
  private backend: BridgeBackend | null = null;
  private signature: string | null = null;
  private lifecycleChain: Promise<void> = Promise.resolve();
  private readonly forcedMode: BridgeMode | null;
  private readonly backendOptions: ResolvedAppServerBackendOptions;
  private readonly createBackendImpl: (
    mode: BridgeMode,
    boundThread: BoundThread | null,
    backendOptions: ResolvedAppServerBackendOptions,
  ) => BridgeBackend;
  private readonly waitForPortClosedImpl: (port: number, timeoutMs?: number) => Promise<void>;

  constructor(
    private readonly config: BridgeConfig,
    private readonly state: BridgeState,
    private readonly logger: Logger,
    options: BridgeBackendManagerOptions = {},
  ) {
    super();
    this.forcedMode = options.forcedMode ?? null;
    this.backendOptions = resolveAppServerBackendOptions(config, options satisfies AppServerBackendOptions);
    this.createBackendImpl = options.createBackend ?? ((mode, boundThread) => this.createBackend(mode, boundThread));
    this.waitForPortClosedImpl = options.waitForPortClosed ?? waitForPortClosed;
  }

  async start(): Promise<void> {
    await this.sync(true, true);
  }

  async close(): Promise<void> {
    await this.runLifecycleStep(async () => {
      const backend = this.backend;
      if (!backend) {
        return;
      }
      await backend.close();
      this.backend = null;
      this.signature = null;
      if (modeUsesAppServer(backend.mode)) {
        await this.waitForPortClosedImpl(this.backendOptions.appServerPort).catch(() => undefined);
      }
    });
  }

  getMode(): BridgeMode {
    if (this.forcedMode) {
      return this.forcedMode;
    }
    return this.state.getMode(defaultBridgeMode(this.config));
  }

  setOwner(owner: BridgeOwner): void {
    this.state.setOwner(owner);
  }

  getOwner(): BridgeOwner {
    return this.state.getOwner("none");
  }

  setSleeping(value: boolean): void {
    this.state.setSleeping(value);
  }

  isSleeping(): boolean {
    return this.state.isSleeping();
  }

  getThreadId(): string | null {
    return this.backend?.getThreadId() ?? null;
  }

  getBoundThread(): BoundThread | null {
    return this.state.getBoundThread();
  }

  getExecutionCwd(): string | null {
    return this.backend?.getExecutionCwd() ?? null;
  }

  canRelayApprovals(): boolean {
    return this.backend?.canRelayApprovals() ?? false;
  }

  hasActiveTurn(): boolean {
    return this.backend?.hasActiveTurn() ?? false;
  }

  supportsResetThread(): boolean {
    return this.backend?.supportsResetThread() ?? false;
  }

  async resetThread(): Promise<string> {
    if (!this.backend) {
      throw new Error("Codex backend is not initialized.");
    }
    return this.backend.resetThread();
  }

  async startTurn(input: CodexTurnInput[]) {
    if (!this.backend) {
      throw new Error("Codex backend is not initialized.");
    }
    return this.backend.startTurn(input);
  }

  async interruptActiveTurn(): Promise<void> {
    await this.backend?.interruptActiveTurn();
  }

  async respondToServerRequest(requestId: string | number, payload: unknown): Promise<void> {
    if (!this.backend) {
      throw new Error("Codex backend is not initialized.");
    }
    await this.backend.respondToServerRequest(requestId, payload);
  }

  async rejectServerRequest(requestId: string | number, message: string): Promise<void> {
    if (!this.backend) {
      throw new Error("Codex backend is not initialized.");
    }
    await this.backend.rejectServerRequest(requestId, message);
  }

  async setMode(mode: BridgeMode): Promise<void> {
    const previous = this.getMode();
    if (previous === mode) {
      return;
    }
    this.state.setMode(mode);
    try {
      await this.sync(true, true);
    } catch (error) {
      this.state.setMode(previous);
      await this.sync(true).catch(() => undefined);
      throw error;
    }
  }

  async setBoundThread(binding: BoundThread | null): Promise<void> {
    const previous = this.getBoundThread();
    const previousClone = previous ? { ...previous } : null;
    this.state.setBoundThread(binding ? { ...binding } : null);
    try {
      await this.sync(true, true);
    } catch (error) {
      this.state.setBoundThread(previousClone);
      await this.sync(true).catch(() => undefined);
      throw error;
    }
  }

  getStatus(): BackendStatus & {
    owner: BridgeOwner;
    sleeping: boolean;
    queueCount: number;
    pendingApprovals: number;
    activeTask: ActiveTaskRecord | null;
  } {
    const status = this.backend?.getStatus() ?? {
      mode: this.getMode(),
      threadId: null,
      cwd: null,
      binding: this.getBoundThread(),
      supportsReset: false,
      supportsApprovals: false,
    };
    return {
      ...status,
      owner: this.getOwner(),
      sleeping: this.isSleeping(),
      queueCount: this.state.getQueuedTaskCount(),
      pendingApprovals: this.state.getPendingApprovalCount(),
      activeTask: this.state.getActiveTask(),
    };
  }

  onBackendUnavailable(handler: (event: BridgeBackendUnavailableEvent) => void): void {
    this.on("backendUnavailable", handler);
  }

  async sync(force = false, throwOnFailure = false): Promise<void> {
    return this.runLifecycleStep(async () => {
      await this.performSync(force, throwOnFailure);
    });
  }

  private async performSync(force = false, throwOnFailure = false): Promise<void> {
    const mode = this.getMode();
    const boundThread = this.getBoundThread();
    const nextSignature = backendSignature(mode, boundThread);
    if (!force && this.signature === nextSignature && this.backend?.isAvailable()) {
      return;
    }
    if (!force && this.backend?.hasActiveTurn()) {
      this.logger.warn("backend reload deferred because a turn is active", { mode });
      return;
    }

    if ((mode === "shared-thread-resume" || mode === "shadow-window") && !boundThread) {
      this.logger.warn("desired backend mode requires a bound thread; backend stays unloaded until one is attached", {
        mode,
      });
      if (this.backend) {
        await this.backend.close().catch(closeError => {
          this.logger.warn("failed to close previous backend", {
            error: closeError instanceof Error ? closeError.message : String(closeError),
          });
        });
        this.backend = null;
      }
      this.signature = nextSignature;
      return;
    }

    const previous = this.backend;
    const previousSignature = this.signature;
    const currentMode = previous?.mode ?? null;
    const requiresExclusiveAppServer = Boolean(previous)
      && (modeUsesAppServer(mode) || (currentMode ? modeUsesAppServer(currentMode) : false));

    const previousWasClosed = Boolean(previous && requiresExclusiveAppServer);
    if (previous && requiresExclusiveAppServer) {
      await previous.close().catch(closeError => {
        throw new Error(
          `Failed to close previous backend before replacement: ${
            closeError instanceof Error ? closeError.message : String(closeError)
          }`,
        );
      });
      this.backend = null;
      this.signature = null;
      if (modeUsesAppServer(mode)) {
        await this.waitForPortClosedImpl(this.backendOptions.appServerPort);
      }
    }

    const candidate = this.createBackendImpl(mode, boundThread, this.backendOptions);
    candidate.onServerRequest((request: JsonRpcRequest) => this.emit("serverRequest", request));
    candidate.onTurnStarted((event: BridgeTurnStartedEvent) => this.emit("turnStarted", event));
    candidate.onTurnFinalText((event: BridgeTurnFinalTextEvent) => this.emit("turnFinalText", event));
    candidate.onUnavailable((event: BridgeBackendUnavailableEvent) => this.emit("backendUnavailable", event));

    try {
      await candidate.start();
    } catch (error) {
      await candidate.close().catch(closeError => {
        this.logger.warn("failed to close candidate backend after startup failure", {
          mode,
          error: closeError instanceof Error ? closeError.message : String(closeError),
        });
      });
      this.logger.error("failed to start desired backend", {
        mode,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!previous || previousWasClosed || throwOnFailure) {
        throw error;
      }
      this.backend = previous;
      this.signature = previousSignature;
      return;
    }

    this.backend = candidate;
    this.signature = nextSignature;
    if (previous && !requiresExclusiveAppServer) {
      await previous.close().catch(closeError => {
        this.logger.warn("failed to close previous backend", {
          error: closeError instanceof Error ? closeError.message : String(closeError),
        });
      });
    }
  }

  private async runLifecycleStep<T>(step: () => Promise<T>): Promise<T> {
    const run = this.lifecycleChain.then(step, step);
    this.lifecycleChain = run.then(() => undefined, () => undefined);
    return await run;
  }

  private createBackend(mode: BridgeMode, boundThread: BoundThread | null): BridgeBackend {
    switch (mode) {
      case "autonomous-thread":
        return new AutonomousThreadBackend(this.config, this.state, this.logger, this.backendOptions);
      case "shared-thread-resume":
        if (!boundThread) {
          throw new Error("shared-thread-resume mode requires a bound desktop thread.");
        }
        return new SharedThreadBackend(this.config, this.state, this.logger, boundThread, this.backendOptions);
      case "shadow-window":
        if (!boundThread) {
          throw new Error("shadow-window mode requires a bound desktop thread.");
        }
        return new ShadowWindowBackend(this.config, boundThread);
      default:
        throw new Error(`Unsupported bridge mode: ${mode}`);
    }
  }
}
