import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, describe, expect, test, vi } from "vitest";

import { defaultBranding, type BridgeConfig } from "../src/core/config.js";
import { BridgeBackendManager } from "../src/core/codex/manager.js";
import type { BridgeBackend, CodexTurnInput } from "../src/core/codex/session.js";
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
      web_search: true,
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

function createManager(options?: ConstructorParameters<typeof BridgeBackendManager>[3]) {
  const root = mkdtempSync(join(tmpdir(), "telegram-codex-bridge-manager-"));
  tempRoots.push(root);
  const config = createConfig(root);
  const state = new BridgeState(config.storageRoot);
  const logger = {
    info() {},
    warn() {},
    error() {},
  };
  return {
    config,
    state,
    manager: new BridgeBackendManager(config, state, logger, options),
  };
}

function makeBackend(
  mode: BridgeMode,
  callbacks?: {
    start?: () => Promise<void> | void;
    close?: () => Promise<void> | void;
  },
): BridgeBackend {
  const status: BackendStatus = {
    mode,
    threadId: null,
    cwd: null,
    binding: null,
    supportsReset: false,
    supportsApprovals: false,
  };
  return {
    mode,
    async start() {
      await callbacks?.start?.();
    },
    async close() {
      await callbacks?.close?.();
    },
    async startTurn(_input: CodexTurnInput[]) {
      throw new Error("unused");
    },
    async interruptActiveTurn() {},
    async respondToServerRequest() {},
    async rejectServerRequest() {},
    onServerRequest() {},
    onTurnStarted() {},
    onTurnFinalText() {},
    onUnavailable() {},
    getThreadId() {
      return null;
    },
    getBoundThread(): BoundThread | null {
      return null;
    },
    getExecutionCwd() {
      return null;
    },
    supportsResetThread() {
      return false;
    },
    async resetThread() {
      throw new Error("unused");
    },
    canRelayApprovals() {
      return false;
    },
    hasActiveTurn() {
      return false;
    },
    isAvailable() {
      return true;
    },
    getStatus() {
      return status;
    },
  };
}

describe("BridgeBackendManager", () => {
  test("closes the previous app-server backend before starting a forced replacement", async () => {
    const order: string[] = [];
    const previous = makeBackend("autonomous-thread", {
      async close() {
        order.push("previous.close");
      },
    });
    const candidate = makeBackend("autonomous-thread", {
      async start() {
        order.push("candidate.start");
      },
    });
    const { manager } = createManager({
      createBackend: vi.fn(() => candidate),
      async waitForPortClosed(port) {
        order.push(`wait:${port}`);
      },
    });

    const internal = manager as any;
    internal.backend = previous;
    internal.signature = JSON.stringify({ mode: "autonomous-thread", binding: null });

    await manager.sync(true, true);

    expect(order).toEqual(["previous.close", "wait:8765", "candidate.start"]);
  });

  test("serializes concurrent forced sync operations", async () => {
    let activeStarts = 0;
    let maxConcurrentStarts = 0;
    const startOrder: string[] = [];
    const closeOrder: string[] = [];

    const candidateOne = makeBackend("autonomous-thread", {
      async start() {
        activeStarts += 1;
        maxConcurrentStarts = Math.max(maxConcurrentStarts, activeStarts);
        startOrder.push("candidate-1");
        await sleep(40);
        activeStarts -= 1;
      },
      async close() {
        closeOrder.push("candidate-1");
      },
    });

    const candidateTwo = makeBackend("autonomous-thread", {
      async start() {
        activeStarts += 1;
        maxConcurrentStarts = Math.max(maxConcurrentStarts, activeStarts);
        startOrder.push("candidate-2");
        await sleep(40);
        activeStarts -= 1;
      },
      async close() {
        closeOrder.push("candidate-2");
      },
    });

    const createBackend = vi.fn()
      .mockReturnValueOnce(candidateOne)
      .mockReturnValueOnce(candidateTwo);
    const { manager } = createManager({
      createBackend,
      async waitForPortClosed() {
        closeOrder.push("wait");
        await sleep(5);
      },
    });
    const previous = makeBackend("autonomous-thread", {
      async close() {
        closeOrder.push("previous");
      },
    });
    const internal = manager as any;
    internal.backend = previous;
    internal.signature = JSON.stringify({ mode: "autonomous-thread", binding: null });

    await Promise.all([
      manager.sync(true, true),
      manager.sync(true, true),
    ]);

    expect(maxConcurrentStarts).toBe(1);
    expect(startOrder).toEqual(["candidate-1", "candidate-2"]);
    expect(closeOrder).toEqual(["previous", "wait", "candidate-1", "wait"]);
  });
});
