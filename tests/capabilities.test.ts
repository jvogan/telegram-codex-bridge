import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "vitest";

import { defaultBranding, type BridgeConfig, type BridgeEnv } from "../src/core/config.js";
import { renderCapabilityLines } from "../src/core/capabilities.js";
import { setManagedTunnelRecoveryCooldown } from "../src/core/realtime/tunnel-cooldown.js";
import { BridgeState } from "../src/core/state.js";
import type { BoundThread, ProviderStatus } from "../src/core/types.js";

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
    bridgeModeExplicit: true,
  };
}

function armCallSurface(state: BridgeState): void {
  state.setCallSurface({
    armed: true,
    armedAt: 1,
    armedBy: "test",
    expiresAt: 60_000,
    lastActivityAt: 1,
    lastPublicProbeAt: null,
    lastPublicProbeReady: null,
    lastPublicProbeDetail: null,
    lastPublicUrl: null,
    lastHealthUrl: null,
    lastLaunchUrl: null,
    lastDisarmReason: null,
    launchTokenId: "launch-token",
    launchTokenBridgeId: "bridge",
    launchTokenTelegramUserId: "123",
    launchTokenTelegramChatInstance: null,
    launchTokenReservedAt: null,
    launchTokenExpiresAt: 60_000,
    tunnelMode: "static-public-url",
    tunnelPid: null,
    tunnelUrl: null,
    tunnelStartedAt: null,
  });
}

describe("renderCapabilityLines", () => {
  test("explains same-session and bridge-managed capabilities", () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-capabilities-"));
    tempRoots.push(root);
    const config = createConfig(root);
    const state = new BridgeState(config.storageRoot);
    const env: BridgeEnv = {
      telegramBotToken: "token",
      openaiApiKey: "openai",
      elevenlabsApiKey: null,
      googleGenAiApiKey: "google",
      realtimeControlSecret: "secret",
    };
    state.setCallSurface({
      armed: true,
      armedAt: Date.now(),
      armedBy: "test",
      expiresAt: Date.now() + 300_000,
      lastActivityAt: Date.now(),
      lastPublicProbeAt: null,
      lastPublicProbeReady: null,
      lastPublicProbeDetail: null,
      lastPublicUrl: null,
      lastHealthUrl: null,
      lastLaunchUrl: null,
      lastDisarmReason: null,
      launchTokenId: "launch-token",
      launchTokenBridgeId: "bridge",
      launchTokenTelegramUserId: "123",
      launchTokenTelegramChatInstance: null,
      launchTokenReservedAt: null,
      launchTokenExpiresAt: Date.now() + 600_000,
      tunnelMode: "static-public-url",
      tunnelPid: null,
      tunnelUrl: null,
      tunnelStartedAt: null,
    });
    const binding: BoundThread = {
      threadId: "thread-123",
      cwd: "/repo",
      rolloutPath: "/tmp/rollout.jsonl",
      source: "vscode",
      boundAt: Date.now(),
    };
    const providerStatuses = {
      asr: [
        { id: "openai", modality: "asr", available: true, reachable: true, detail: "api key present" },
      ] satisfies ProviderStatus[],
      tts: [
        { id: "openai", modality: "tts", available: true, reachable: true, detail: "api key present" },
        { id: "elevenlabs", modality: "tts", available: false, reachable: false, detail: "missing api key" },
      ] satisfies ProviderStatus[],
      image_generation: [
        { id: "google", modality: "image_generation", available: true, reachable: true, detail: "api key present" },
        { id: "openai", modality: "image_generation", available: true, reachable: true, detail: "api key present" },
      ] satisfies ProviderStatus[],
    };

    const lines = renderCapabilityLines(config, env, state, {
      runtime: {
        mode: "shared-thread-resume",
        owner: "telegram",
        binding,
        threadId: "thread-123",
        cwd: "/repo",
        daemonRunning: true,
        gatewayReady: true,
        gatewayBridgeReady: true,
      },
      chains: {
        asr: ["openai"],
        tts: ["openai", "elevenlabs"],
        image_generation: ["google", "openai"],
      },
      providerStatuses,
    });

    const rendered = lines.join("\n");
    expect(rendered).toContain("Bound desktop Codex thread");
    expect(rendered).toContain("TELEGRAM_BOT_TOKEN: present");
    expect(rendered).toContain("Authorized chat: *** (3 chars)");
    expect(rendered).toContain("Telegram daemon: running");
    expect(rendered).toContain("Desktop thread binding: ready");
    expect(rendered).toContain("Telegram photo input: ready");
    expect(rendered).toContain("Telegram document/file input: ready");
    expect(rendered).toContain("PDFs and rich docs get best-effort text extraction");
    expect(rendered).toContain("Telegram video input: ready");
    expect(rendered).toContain("Generated files/documents/videos: ready");
    expect(rendered).toContain("Telegram voice/audio input: ready via openai");
    expect(rendered).toContain("TTS replies: ready via Codex media tools or the /speak shortcut using openai");
    expect(rendered).toContain("Image generation: ready via natural-language direct image handling, Codex media tools, or the /image shortcut using google");
    expect(rendered).toContain("Bridge-direct image generation mode");
    expect(rendered).toContain("Realtime calls: ready");
    expect(rendered).toContain("600s per call, 1800s daily");
    expect(rendered).toContain("0 calls today");
    expect(rendered).toContain("next call capped at 600s");
    expect(rendered).toContain("Optional terminal lane");
    expect(rendered).toContain("Terminal lane: disabled (profile=public-safe, sandbox=read-only, approvals=never)");
    expect(rendered).toContain("Safe tmux lane: disabled; set terminal_lane.enabled = true, install tmux");
    expect(rendered).toContain("Terminal superpowers: locked");
    expect(rendered).toContain("User-owned terminals: disabled");
    expect(rendered).toContain("Terminal controls: disabled");
    expect(rendered).toContain("Natural usage: ask for images, videos, documents, or spoken replies directly in plain English");
    expect(rendered).toContain("reply with audio");
    expect(rendered).toContain("review this video");
    expect(rendered).toContain("make me a PDF summary and send it back");
    expect(rendered).toContain("Repo/file/tool/web capabilities are inherited from the bound desktop Codex session.");
    expect(rendered).toContain("shadow-window is experimental, macOS-only, and non-core.");
  });

  test("reports codex-native image generation mode", () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-capabilities-"));
    tempRoots.push(root);
    const config = createConfig(root);
    const state = new BridgeState(config.storageRoot);
    state.setSetting("telegram:image_generation_mode", "codex-native");
    const env: BridgeEnv = {
      telegramBotToken: "token",
      openaiApiKey: null,
      elevenlabsApiKey: null,
      googleGenAiApiKey: null,
      realtimeControlSecret: null,
    };

    const lines = renderCapabilityLines(config, env, state, {
      runtime: {
        mode: "shared-thread-resume",
        owner: "telegram",
        binding: {
          threadId: "thread-123",
          cwd: "/repo",
          rolloutPath: "/tmp/rollout.jsonl",
          source: "vscode",
          boundAt: Date.now(),
        },
        threadId: null,
        cwd: "/repo",
        daemonRunning: true,
        gatewayReady: false,
        gatewayBridgeReady: false,
      },
      chains: {
        asr: ["openai"],
        tts: ["openai", "elevenlabs"],
        image_generation: ["google", "openai"],
      },
      providerStatuses: {
        asr: [],
        tts: [],
        image_generation: [],
      },
    }).join("\n");

    expect(lines).toContain("Image generation: ready via bound Codex native image generation for natural Telegram requests");
    expect(lines).toContain("Native Codex image generation mode: enabled");
  });

  test("surfaces an unreachable public Mini App origin", () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-capabilities-"));
    tempRoots.push(root);
    const config = createConfig(root);
    const state = new BridgeState(config.storageRoot);
    const env: BridgeEnv = {
      telegramBotToken: "token",
      openaiApiKey: "openai",
      elevenlabsApiKey: null,
      googleGenAiApiKey: "google",
      realtimeControlSecret: "secret",
    };
    state.setCallSurface({
      armed: true,
      armedAt: Date.now(),
      armedBy: "test",
      expiresAt: Date.now() + 300_000,
      lastActivityAt: Date.now(),
      lastPublicProbeAt: null,
      lastPublicProbeReady: null,
      lastPublicProbeDetail: null,
      lastPublicUrl: null,
      lastHealthUrl: null,
      lastLaunchUrl: null,
      lastDisarmReason: null,
      launchTokenId: "launch-token",
      launchTokenBridgeId: "bridge",
      launchTokenTelegramUserId: "123",
      launchTokenTelegramChatInstance: null,
      launchTokenReservedAt: null,
      launchTokenExpiresAt: Date.now() + 600_000,
      tunnelMode: "static-public-url",
      tunnelPid: null,
      tunnelUrl: null,
      tunnelStartedAt: null,
    });

    const lines = renderCapabilityLines(config, env, state, {
      runtime: {
        mode: "shared-thread-resume",
        owner: "telegram",
        binding: null,
        threadId: null,
        cwd: "/repo",
        daemonRunning: true,
        gatewayReady: true,
        gatewayBridgeReady: true,
        realtimePublicReady: false,
        realtimePublicDetail: "public origin is unreachable (DNS lookup failed)",
      },
      chains: {
        asr: ["openai"],
        tts: ["openai", "elevenlabs"],
        image_generation: ["google", "openai"],
      },
      providerStatuses: {
        asr: [],
        tts: [],
        image_generation: [],
      },
    });

    expect(lines.join("\n")).toContain("Realtime calls: public origin is unreachable (DNS lookup failed)");
    expect(lines.join("\n")).toContain("Desktop thread binding: missing (run `npm run bridge:claim` from the Codex Desktop session you want Telegram to inherit)");
  });

  test("surfaces daemon issues ahead of public-surface details", () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-capabilities-"));
    tempRoots.push(root);
    const config = createConfig(root);
    const state = new BridgeState(config.storageRoot);
    const env: BridgeEnv = {
      telegramBotToken: "token",
      openaiApiKey: "openai",
      elevenlabsApiKey: null,
      googleGenAiApiKey: "google",
      realtimeControlSecret: "secret",
    };
    armCallSurface(state);

    const lines = renderCapabilityLines(config, env, state, {
      runtime: {
        mode: "shared-thread-resume",
        owner: "telegram",
        binding: {
          threadId: "thread-123",
          cwd: "/repo",
          rolloutPath: "/tmp/rollout.jsonl",
          source: "vscode",
          boundAt: Date.now(),
        },
        threadId: "thread-123",
        cwd: "/repo",
        daemonRunning: false,
        daemonIssue: "port 8765 is occupied by python3.12 (pid 54367) from /tmp/foreign-app",
        gatewayReady: true,
        gatewayBridgeReady: false,
        realtimePublicReady: false,
        realtimePublicDetail: "public origin is unreachable (DNS lookup failed)",
      },
      chains: {
        asr: ["openai"],
        tts: ["openai", "elevenlabs"],
        image_generation: ["google", "openai"],
      },
      providerStatuses: {
        asr: [],
        tts: [],
        image_generation: [],
      },
    });

    expect(lines.join("\n")).toContain("Telegram daemon: not running (port 8765 is occupied by python3.12 (pid 54367) from /tmp/foreign-app)");
    expect(lines.join("\n")).toContain("Realtime calls: port 8765 is occupied by python3.12 (pid 54367) from /tmp/foreign-app");
  });

  test("reports blocked live-call readiness instead of ready", () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-capabilities-"));
    tempRoots.push(root);
    const config = createConfig(root);
    const state = new BridgeState(config.storageRoot);
    const env: BridgeEnv = {
      telegramBotToken: "token",
      openaiApiKey: "openai",
      elevenlabsApiKey: null,
      googleGenAiApiKey: "google",
      realtimeControlSecret: "secret",
    };
    armCallSurface(state);

    const lines = renderCapabilityLines(config, env, state, {
      runtime: {
        mode: "shared-thread-resume",
        owner: "telegram",
        binding: {
          threadId: "thread-123",
          cwd: "/repo",
          rolloutPath: "/tmp/rollout.jsonl",
          source: "vscode",
          boundAt: Date.now(),
        },
        threadId: "thread-123",
        cwd: "/repo",
        daemonRunning: true,
        gatewayReady: true,
        gatewayBridgeReady: true,
        launchTokenReady: true,
        realtimeStartBlocker: "There is 1 queued Telegram task.",
      },
      chains: {
        asr: ["openai"],
        tts: ["openai", "elevenlabs"],
        image_generation: ["google", "openai"],
      },
      providerStatuses: {
        asr: [],
        tts: [],
        image_generation: [],
      },
    });

    expect(lines.join("\n")).toContain("Realtime calls: currently blocked (There is 1 queued Telegram task.)");
  });

  test("treats a consumed launch token as not reusable", () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-capabilities-"));
    tempRoots.push(root);
    const config = createConfig(root);
    const state = new BridgeState(config.storageRoot);
    const env: BridgeEnv = {
      telegramBotToken: "token",
      openaiApiKey: "openai",
      elevenlabsApiKey: null,
      googleGenAiApiKey: "google",
      realtimeControlSecret: "secret",
    };
    armCallSurface(state);

    const lines = renderCapabilityLines(config, env, state, {
      runtime: {
        mode: "shared-thread-resume",
        owner: "telegram",
        binding: {
          threadId: "thread-123",
          cwd: "/repo",
          rolloutPath: "/tmp/rollout.jsonl",
          source: "vscode",
          boundAt: Date.now(),
        },
        threadId: "thread-123",
        cwd: "/repo",
        daemonRunning: true,
        gatewayReady: true,
        gatewayBridgeReady: true,
        launchTokenReady: false,
        realtimeStartBlocker: null,
      },
      chains: {
        asr: ["openai"],
        tts: ["openai", "elevenlabs"],
        image_generation: ["google", "openai"],
      },
      providerStatuses: {
        asr: [],
        tts: [],
        image_generation: [],
      },
    });

    expect(lines.join("\n")).toContain("Realtime calls: launch token is not currently reusable; run `bridgectl call arm` to mint a fresh invite");
  });

  test("surfaces managed tunnel cooldown before generic disarmed status", () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-capabilities-"));
    tempRoots.push(root);
    const config = createConfig(root);
    config.realtime.tunnel_mode = "managed-quick-cloudflared";
    config.realtime.public_url = "";
    const state = new BridgeState(config.storageRoot);
    const env: BridgeEnv = {
      telegramBotToken: "token",
      openaiApiKey: "openai",
      elevenlabsApiKey: null,
      googleGenAiApiKey: "google",
      realtimeControlSecret: "secret",
    };
    setManagedTunnelRecoveryCooldown(
      state,
      "call arm",
      "status_code=\"429\" error code: 1015 Too Many Requests",
      Date.now(),
    );

    const lines = renderCapabilityLines(config, env, state, {
      runtime: {
        mode: "shared-thread-resume",
        owner: "telegram",
        binding: {
          threadId: "thread-123",
          cwd: "/repo",
          rolloutPath: "/tmp/rollout.jsonl",
          source: "vscode",
          boundAt: Date.now(),
        },
        threadId: "thread-123",
        cwd: "/repo",
        daemonRunning: true,
        gatewayReady: true,
        gatewayBridgeReady: true,
      },
      chains: {
        asr: ["openai"],
        tts: ["openai", "elevenlabs"],
        image_generation: ["google", "openai"],
      },
      providerStatuses: {
        asr: [],
        tts: [],
        image_generation: [],
      },
    });

    expect(lines.join("\n")).toContain("Realtime calls: managed tunnel recovery cooling down");
  });

  test("reports explicit terminal lane gates for power users", () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-capabilities-"));
    tempRoots.push(root);
    const config = createConfig(root);
    config.terminal_lane.enabled = true;
    config.terminal_lane.backend = "iterm2";
    config.terminal_lane.daemon_owned = false;
    config.terminal_lane.profile = "power-user";
    config.terminal_lane.sandbox = "workspace-write";
    config.terminal_lane.approval_policy = "on-request";
    config.terminal_lane.allow_user_owned_sessions = true;
    config.terminal_lane.allow_terminal_control = true;
    const state = new BridgeState(config.storageRoot);
    state.setSetting("terminal:codex_identity", {
      backend: "iterm2",
      name: "private-window-title",
      lockedAt: Date.now(),
      daemonOwned: false,
    });
    const env: BridgeEnv = {
      telegramBotToken: "token",
      openaiApiKey: null,
      elevenlabsApiKey: null,
      googleGenAiApiKey: null,
      realtimeControlSecret: null,
    };

    const lines = renderCapabilityLines(config, env, state, {
      runtime: {
        mode: "shared-thread-resume",
        owner: "telegram",
        binding: null,
        threadId: null,
        cwd: "/repo",
        daemonRunning: true,
        gatewayReady: false,
        gatewayBridgeReady: false,
      },
      chains: {
        asr: ["openai"],
        tts: ["openai", "elevenlabs"],
        image_generation: ["google", "openai"],
      },
      providerStatuses: {
        asr: [],
        tts: [],
        image_generation: [],
      },
    });

    const rendered = lines.join("\n");
    expect(rendered).toContain("Terminal lane: enabled (profile=power-user, sandbox=workspace-write, approvals=on-request)");
    expect(rendered).toContain("Selected terminal backend: iterm2; locked session: yes (iterm2)");
    expect(rendered).not.toContain("private-window-title");
    expect(rendered).toContain("Safe tmux lane: not the selected path");
    expect(rendered).toContain("Terminal superpowers: enabled by config; keep approvals on-request for write-capable work.");
    expect(rendered).toContain("User-owned terminals: enabled");
    expect(rendered).toContain("Terminal controls: enabled");
  });

  test("renders Telegram-facing capabilities without operator metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-capabilities-"));
    tempRoots.push(root);
    const config = createConfig(root);
    const state = new BridgeState(config.storageRoot);
    const env: BridgeEnv = {
      telegramBotToken: "token",
      openaiApiKey: "openai",
      elevenlabsApiKey: null,
      googleGenAiApiKey: "google",
      realtimeControlSecret: "secret",
    };
    const lines = renderCapabilityLines(config, env, state, {
      runtime: {
        mode: "shared-thread-resume",
        owner: "telegram",
        binding: {
          threadId: "thread-123",
          cwd: "/workspace/project",
          rolloutPath: "/tmp/rollout.jsonl",
          source: "vscode",
          boundAt: Date.now(),
        },
        threadId: "thread-123",
        cwd: "/workspace/project",
        daemonRunning: true,
        gatewayReady: true,
        gatewayBridgeReady: true,
      },
      chains: {
        asr: ["openai"],
        tts: ["openai"],
        image_generation: ["openai"],
      },
      providerStatuses: {
        asr: [{ id: "openai", modality: "asr", available: true, reachable: true, detail: "api key present" }],
        tts: [{ id: "openai", modality: "tts", available: true, reachable: true, detail: "api key present" }],
        image_generation: [{ id: "openai", modality: "image_generation", available: true, reachable: true, detail: "api key present" }],
      },
    }, { audience: "telegram" });

    const rendered = lines.join("\n");
    expect(rendered).toContain("Voice/audio understanding: ready");
    expect(rendered).toContain("Live calls: available; say 'call me' or send /call to start");
    expect(rendered).toContain("Terminal lane: not enabled; ask the local Codex setup agent about the safe tmux lane");
    expect(rendered).toContain("Ask normally for images, files, spoken replies, web lookup, or file inspection.");
    expect(rendered).not.toContain("thread-123");
    expect(rendered).not.toContain("/workspace/project");
    expect(rendered).not.toContain("OPENAI_API_KEY");
    expect(rendered).not.toContain("Provider chains");
    expect(rendered).not.toContain("bridgectl");
  });
});
