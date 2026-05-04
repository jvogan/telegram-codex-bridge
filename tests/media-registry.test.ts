import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { BridgeConfig, BridgeEnv } from "../src/core/config.js";
import { defaultBranding } from "../src/core/config.js";
import { MediaRegistry } from "../src/core/media/registry.js";
import { BridgeState } from "../src/core/state.js";

const tempRoots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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
      mode: "shared-thread-resume",
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
      root: ".bridge-data",
      retention_days: 14,
    },
    branding: defaultBranding,
    presentation: {
      demo_practice_mode: false,
    },
    providers: {
      defaults: {
        asr: "openai",
        tts: "openai",
        image_generation: "openai",
      },
      fallbacks: {
        asr: ["openai"],
        tts: ["openai", "elevenlabs"],
        image_generation: ["openai"],
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
        enabled: false,
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
      startup_timeout_ms: 45_000,
      idle_warning_ms: 120_000,
      idle_timeout_ms: 600_000,
      auto_disarm_idle_ms: 300_000,
      launch_token_ttl_ms: 600_000,
      bootstrap_rate_limit_window_ms: 600_000,
      bootstrap_rate_limit_per_ip: 5,
      bootstrap_rate_limit_per_bridge: 10,
      bootstrap_rate_limit_per_user: 3,
      max_call_ms: 600_000,
      max_daily_call_ms: 1_800_000,
      summary_model: "gpt-4.1-mini",
    },
    configPath: join(root, "bridge.config.toml"),
    repoRoot: root,
    storageRoot: join(root, ".bridge-data"),
    bridgeModeExplicit: true,
  };
}

function createEnv(): BridgeEnv {
  return {
    telegramBotToken: null,
    openaiApiKey: "test-openai-key",
    elevenlabsApiKey: "test-elevenlabs-key",
    googleGenAiApiKey: null,
    realtimeControlSecret: null,
  };
}

describe("MediaRegistry provider fallbacks", () => {
  test("reports provider statuses under the requested modality bucket", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-bridge-media-registry-"));
    tempRoots.push(root);
    const registry = new MediaRegistry(createConfig(root), createEnv(), new BridgeState(join(root, ".bridge-data")));

    const statuses = await registry.getProviderStatuses();

    expect(statuses.asr.every(status => status.modality === "asr")).toBe(true);
    expect(statuses.tts.every(status => status.modality === "tts")).toBe(true);
    expect(statuses.image_generation.every(status => status.modality === "image_generation")).toBe(true);
  });

  test("moves to the next TTS provider when the first provider hangs", async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-bridge-media-registry-"));
    tempRoots.push(root);
    const registry = new MediaRegistry(createConfig(root), createEnv(), new BridgeState(join(root, ".bridge-data")));
    const internals = registry as unknown as {
      ttsProviders: Record<string, { speak(input: unknown): Promise<unknown> }>;
    };
    internals.ttsProviders.openai = {
      speak: async () => new Promise(() => undefined),
    };
    internals.ttsProviders.elevenlabs = {
      speak: async () => ({
        providerId: "elevenlabs",
        buffer: Buffer.from("ok"),
        mimeType: "audio/mpeg",
        fileExtension: "mp3",
      }),
    };

    const result = registry.speak({ text: "hello" });
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(result).resolves.toMatchObject({
      providerId: "elevenlabs",
      mimeType: "audio/mpeg",
    });
  });
});
