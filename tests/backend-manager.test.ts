import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "vitest";

import { defaultBranding, type BridgeConfig } from "../src/core/config.js";
import type { Logger } from "../src/core/logger.js";
import { BridgeBackendManager } from "../src/core/codex/manager.js";
import type {
  BridgeBackend,
  BridgeBackendUnavailableEvent,
  BridgeTurnFinalTextEvent,
  BridgeTurnStartedEvent,
  CodexTurnInput,
} from "../src/core/codex/session.js";
import type { JsonRpcId, JsonRpcRequest, TurnResult } from "../src/core/codex/protocol.js";
import { BridgeState } from "../src/core/state.js";
import type { BackendStatus, BoundThread, BridgeMode } from "../src/core/types.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function createConfig(root: string): BridgeConfig {
  return {
    telegram: {
      authorized_chat_id: "123",
      transport: "long-polling",
      poll_timeout_seconds: 30,
      long_poll_limit: 25,
      clear_webhook_on_start: false,
    },
    bridge: {
      mode: "autonomous-thread",
      codex_binary: "/Applications/Codex.app/Contents/Resources/codex",
    },
    terminal_lane: {
      enabled: false,
      backend: "tmux",
      session_name: "telegram-codex-bridge-terminal",
      workdir: "",
      codex_command: "",
      profile: "public-safe",
      sandbox: "read-only",
      approval_policy: "never",
      model: "",
      reasoning_effort: "low",
      codex_profile: "",
      daemon_owned: true,
      allow_user_owned_sessions: false,
      allow_terminal_control: false,
    },
    codex: {
      workdir: root,
      approval_policy: "on-request",
      sandbox: "workspace-write",
      app_server_port: 8765,
      model: "",
    },
    storage: {
      root: "./.bridge-data",
      retention_days: 14,
    },
    branding: { ...defaultBranding },
    presentation: {
      demo_practice_mode: false,
    },
    providers: {
      defaults: {
        asr: "openai",
        tts: "openai",
        image_generation: "google",
      },
      fallbacks: {
        asr: ["openai"],
        tts: ["openai", "elevenlabs"],
        image_generation: ["google", "openai"],
      },
      openai: {
        enabled: true,
        asr_model: "gpt-4o-transcribe",
        tts_model: "gpt-4o-mini-tts",
        tts_voice: "marin",
        tts_response_format: "wav",
        image_model: "gpt-image-1",
        image_size: "1024x1024",
      },
      elevenlabs: {
        enabled: true,
        tts_model: "eleven_multilingual_v2",
        tts_voice_id: "",
        tts_output_format: "mp3_44100_128",
      },
      google: {
        enabled: true,
        image_model: "imagen-4.0-generate-001",
        image_aspect_ratio: "1:1",
      },
    },
    experimental: {
      enable_shadow_window: false,
    },
    realtime: {
      enabled: false,
      bridge_id: "bridge",
      public_url: "",
      control_url: "",
      surface_mode: "manual-arm",
      tunnel_mode: "managed-quick-cloudflared",
      tunnel_bin: "cloudflared",
      gateway_host: "127.0.0.1",
      gateway_port: 8890,
      model: "gpt-realtime",
      transcription_model: "gpt-4o-mini-transcribe",
      voice: "marin",
      startup_timeout_ms: 25_000,
      idle_warning_ms: 120_000,
      idle_timeout_ms: 600_000,
      auto_disarm_idle_ms: 300_000,
      launch_token_ttl_ms: 600_000,
      bootstrap_rate_limit_window_ms: 600_000,
      bootstrap_rate_limit_per_ip: 5,
      bootstrap_rate_limit_per_bridge: 10,
      bootstrap_rate_limit_per_user: 3,
      max_call_ms: 120_000,
      max_daily_call_ms: 600_000,
      summary_model: "gpt-4.1-mini",
    },
    configPath: join(root, "bridge.config.toml"),
    repoRoot: root,
    storageRoot: join(root, ".bridge-data"),
    bridgeModeExplicit: true,
  };
}

function createStateAndConfig() {
  const root = mkdtempSync(join(tmpdir(), "telegram-codex-backend-manager-"));
  tempRoots.push(root);
  const config = createConfig(root);
  const state = new BridgeState(config.storageRoot);
  return { config, state };
}

function createLogger(): Logger {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

class FakeBackend extends EventEmitter implements BridgeBackend {
  readonly mode: BridgeMode;
  available = true;

  constructor(
    mode: BridgeMode,
    private readonly name: string,
    private readonly events: string[],
    private readonly startError: Error | null = null,
  ) {
    super();
    this.mode = mode;
  }

  async start(): Promise<void> {
    this.events.push(`${this.name}:start`);
    if (this.startError) {
      throw this.startError;
    }
  }

  async close(): Promise<void> {
    this.events.push(`${this.name}:close`);
  }

  async startTurn(_input: CodexTurnInput[]): Promise<TurnResult> {
    throw new Error("not implemented");
  }

  async interruptActiveTurn(): Promise<void> {}

  async respondToServerRequest(_requestId: JsonRpcId, _payload: unknown): Promise<void> {}

  async rejectServerRequest(_requestId: JsonRpcId, _message: string): Promise<void> {}

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
    return null;
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
    throw new Error("not implemented");
  }

  canRelayApprovals(): boolean {
    return false;
  }

  hasActiveTurn(): boolean {
    return false;
  }

  isAvailable(): boolean {
    return this.available;
  }

  getStatus(): BackendStatus {
    return {
      mode: this.mode,
      threadId: null,
      cwd: null,
      binding: null,
      supportsReset: false,
      supportsApprovals: false,
    };
  }
}

describe("BridgeBackendManager", () => {
  test("restarts app-server-backed backends by closing the old backend before starting the next one", async () => {
    const { config, state } = createStateAndConfig();
    const events: string[] = [];
    let backendCount = 0;

    const manager = new BridgeBackendManager(config, state, createLogger(), {
      createBackend(mode) {
        backendCount += 1;
        return new FakeBackend(mode, `backend-${backendCount}`, events);
      },
      async waitForPortClosed(port) {
        events.push(`wait:${port}`);
      },
    });

    await manager.start();
    await manager.sync(true, true);

    expect(events).toEqual([
      "backend-1:start",
      "backend-1:close",
      "wait:8765",
      "backend-2:start",
    ]);
  });

  test("throws if replacement startup fails after the previous app-server backend has already been closed", async () => {
    const { config, state } = createStateAndConfig();
    const events: string[] = [];
    let backendCount = 0;

    const manager = new BridgeBackendManager(config, state, createLogger(), {
      createBackend(mode) {
        backendCount += 1;
        if (backendCount === 2) {
          return new FakeBackend(mode, `backend-${backendCount}`, events, new Error("boom"));
        }
        return new FakeBackend(mode, `backend-${backendCount}`, events);
      },
      async waitForPortClosed(port) {
        events.push(`wait:${port}`);
      },
    });

    await manager.start();

    await expect(manager.sync(true)).rejects.toThrow("boom");
    await expect(manager.startTurn([{ type: "text", text: "hello" }])).rejects.toThrow("not initialized");
    expect(events).toEqual([
      "backend-1:start",
      "backend-1:close",
      "wait:8765",
      "backend-2:start",
      "backend-2:close",
    ]);
  });

  test("recreates the backend when the current app-server backend becomes unavailable", async () => {
    const { config, state } = createStateAndConfig();
    const events: string[] = [];
    let backendCount = 0;
    let firstBackend: FakeBackend | null = null;

    const manager = new BridgeBackendManager(config, state, createLogger(), {
      createBackend(mode) {
        backendCount += 1;
        const backend = new FakeBackend(mode, `backend-${backendCount}`, events);
        if (backendCount === 1) {
          firstBackend = backend;
        }
        return backend;
      },
      async waitForPortClosed(port) {
        events.push(`wait:${port}`);
      },
    });

    await manager.start();
    firstBackend!.available = false;
    await manager.sync();

    expect(events).toEqual([
      "backend-1:start",
      "backend-1:close",
      "wait:8765",
      "backend-2:start",
    ]);
  });

  test("forwards backend unavailable events", async () => {
    const { config, state } = createStateAndConfig();
    const events: string[] = [];
    let backend: FakeBackend | null = null;

    const manager = new BridgeBackendManager(config, state, createLogger(), {
      createBackend(mode) {
        backend = new FakeBackend(mode, "backend-1", events);
        return backend;
      },
    });

    const unavailable = new Promise<BridgeBackendUnavailableEvent>(resolve => {
      manager.onBackendUnavailable(resolve);
    });

    await manager.start();
    backend!.emit("unavailable", {
      reason: "app_server_exit",
      detail: "1",
    } satisfies BridgeBackendUnavailableEvent);

    await expect(unavailable).resolves.toEqual({
      reason: "app_server_exit",
      detail: "1",
    });
  });
});
