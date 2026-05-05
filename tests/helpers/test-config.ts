import { join } from "node:path";

import { defaultBranding } from "../../src/core/config.js";
import type { BridgeConfig, BridgeEnv } from "../../src/core/config.js";

type BridgeConfigOverrides = {
  telegram?: Partial<BridgeConfig["telegram"]>;
  bridge?: Partial<BridgeConfig["bridge"]>;
  terminal_lane?: Partial<BridgeConfig["terminal_lane"]>;
  codex?: Partial<BridgeConfig["codex"]>;
  storage?: Partial<BridgeConfig["storage"]>;
  branding?: Partial<BridgeConfig["branding"]>;
  presentation?: Partial<BridgeConfig["presentation"]>;
  providers?: {
    defaults?: Partial<BridgeConfig["providers"]["defaults"]>;
    fallbacks?: Partial<BridgeConfig["providers"]["fallbacks"]>;
    openai?: Partial<BridgeConfig["providers"]["openai"]>;
    elevenlabs?: Partial<BridgeConfig["providers"]["elevenlabs"]>;
    google?: Partial<BridgeConfig["providers"]["google"]>;
  };
  experimental?: Partial<BridgeConfig["experimental"]>;
  realtime?: Partial<BridgeConfig["realtime"]>;
  bridgeModeExplicit?: boolean;
};

export function createTestBridgeConfig(
  root: string,
  overrides: BridgeConfigOverrides = {},
): BridgeConfig {
  const base: BridgeConfig = {
    telegram: {
      authorized_chat_id: "123",
      transport: "long-polling",
      poll_timeout_seconds: 30,
      long_poll_limit: 25,
      clear_webhook_on_start: false,
    },
    bridge: {
      mode: "shared-thread-resume",
      codex_binary: "",
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
      model: "gpt-5.5",
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
        image_generation: "openai",
      },
      fallbacks: {
        asr: ["openai"],
        tts: ["elevenlabs"],
        image_generation: ["google"],
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
      enabled: true,
      bridge_id: "bridge",
      public_url: "https://example.com",
      control_url: "",
      surface_mode: "manual-arm",
      tunnel_mode: "static-public-url",
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
      max_call_ms: 600_000,
      max_daily_call_ms: 1_800_000,
      summary_model: "gpt-4.1-mini",
    },
    configPath: join(root, "bridge.config.toml"),
    repoRoot: root,
    storageRoot: join(root, ".bridge-data"),
    bridgeModeExplicit: overrides.bridgeModeExplicit ?? true,
  };

  return {
    ...base,
    telegram: { ...base.telegram, ...overrides.telegram },
    bridge: { ...base.bridge, ...overrides.bridge },
    terminal_lane: { ...base.terminal_lane, ...overrides.terminal_lane },
    codex: { ...base.codex, ...overrides.codex },
    storage: { ...base.storage, ...overrides.storage },
    branding: { ...base.branding, ...overrides.branding },
    presentation: { ...base.presentation, ...overrides.presentation },
    providers: {
      defaults: { ...base.providers.defaults, ...overrides.providers?.defaults },
      fallbacks: { ...base.providers.fallbacks, ...overrides.providers?.fallbacks },
      openai: { ...base.providers.openai, ...overrides.providers?.openai },
      elevenlabs: { ...base.providers.elevenlabs, ...overrides.providers?.elevenlabs },
      google: { ...base.providers.google, ...overrides.providers?.google },
    },
    experimental: { ...base.experimental, ...overrides.experimental },
    realtime: { ...base.realtime, ...overrides.realtime },
    bridgeModeExplicit: overrides.bridgeModeExplicit ?? base.bridgeModeExplicit,
  };
}

export function createTestBridgeEnv(overrides: Partial<BridgeEnv> = {}): BridgeEnv {
  return {
    telegramBotToken: null,
    openaiApiKey: null,
    elevenlabsApiKey: null,
    googleGenAiApiKey: null,
    realtimeControlSecret: null,
    ...overrides,
  };
}
