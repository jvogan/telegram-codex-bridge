import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "vitest";

import {
  getManagedTunnelRecoveryCooldown,
  managedTunnelRecoveryCooldownDetail,
  managedTunnelRecoveryCooldownDuration,
  setManagedTunnelRecoveryCooldown,
} from "../src/core/realtime/tunnel-cooldown.js";
import {
  managedQuickTunnelProcessPattern,
  readManagedQuickTunnelUrl,
  resolveManagedTunnelPid,
  summarizeCloudflaredFailure,
  tunnelLogPath,
  tunnelPidPath,
} from "../src/core/realtime/tunnel.js";
import { applyManagedTunnelHandle } from "../src/core/realtime/tunnel-surface.js";
import { defaultBranding } from "../src/core/config.js";
import { BridgeState } from "../src/core/state.js";
import type { BridgeConfig } from "../src/core/config.js";
import type { RealtimeCallSurfaceRecord } from "../src/core/types.js";

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
    branding: defaultBranding,
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

describe("readManagedQuickTunnelUrl", () => {
  test("returns the most recent quick-tunnel URL from the tunnel log", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-tunnel-"));
    tempRoots.push(root);
    const config = createConfig(root);
    mkdirSync(config.storageRoot, { recursive: true });
    writeFileSync(join(config.storageRoot, "realtime-tunnel.log"), [
      "old https://old-subdomain.trycloudflare.com",
      "new https://new-subdomain.trycloudflare.com",
    ].join("\n"));

    await expect(readManagedQuickTunnelUrl(config)).resolves.toBe("https://new-subdomain.trycloudflare.com");
  });
});

describe("summarizeCloudflaredFailure", () => {
  test("returns a compact tail of recent cloudflared warning and error lines", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-tunnel-failure-"));
    tempRoots.push(root);
    const config = createConfig(root);
    mkdirSync(config.storageRoot, { recursive: true });
    writeFileSync(tunnelLogPath(config), [
      "ordinary startup line",
      "2026-05-03T12:00:00Z WRN retrying connection",
      "2026-05-03T12:00:01Z ERR failed to request quick tunnel",
      "2026-05-03T12:00:02Z status_code=\"429\"",
      "2026-05-03T12:00:03Z error code: 1015 Too Many Requests",
      "final nonmatching line",
    ].join("\n"));

    const summary = await summarizeCloudflaredFailure(config);

    expect(summary).toContain("WRN retrying connection");
    expect(summary).toContain("status_code=\"429\"");
    expect(summary).toContain("Too Many Requests");
    expect(summary).not.toContain("ordinary startup line");
    expect(summary).not.toContain("final nonmatching line");
  });

  test("returns null when the tunnel log has no actionable failure lines", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-tunnel-failure-empty-"));
    tempRoots.push(root);
    const config = createConfig(root);
    mkdirSync(config.storageRoot, { recursive: true });
    writeFileSync(tunnelLogPath(config), "Starting tunnel\nConnected\n");

    await expect(summarizeCloudflaredFailure(config)).resolves.toBeNull();
  });
});

describe("resolveManagedTunnelPid", () => {
  test("ignores stale pid files that do not point at cloudflared", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-tunnel-pid-"));
    tempRoots.push(root);
    const config = createConfig(root);
    mkdirSync(config.storageRoot, { recursive: true });
    writeFileSync(tunnelPidPath(config), `${process.pid}\n`);

    await expect(resolveManagedTunnelPid(config)).resolves.toBeNull();
  });
});

describe("managedQuickTunnelProcessPattern", () => {
  test("matches only the managed tunnel command for the configured gateway", () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-tunnel-pattern-"));
    tempRoots.push(root);
    const config = createConfig(root);
    const pattern = managedQuickTunnelProcessPattern(config);

    expect(pattern.test("cloudflared tunnel --url http://127.0.0.1:8890 --no-autoupdate")).toBe(true);
    expect(pattern.test("cloudflared tunnel --url http://127.0.0.1:8891 --no-autoupdate")).toBe(false);
  });
});

describe("managed tunnel recovery cooldown", () => {
  test("uses a longer cooldown for Cloudflare quick tunnel rate limits", () => {
    expect(managedTunnelRecoveryCooldownDuration("status_code=\"429\" error code: 1015 Too Many Requests"))
      .toBeGreaterThan(managedTunnelRecoveryCooldownDuration("public surface probe failed"));
  });

  test("persists and expires operator-visible cooldown details", () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-tunnel-cooldown-"));
    tempRoots.push(root);
    const state = new BridgeState(join(root, ".bridge-data"));
    const now = 1_000;

    const cooldown = setManagedTunnelRecoveryCooldown(
      state,
      "bridgectl call arm",
      "status_code=\"429\" error code: 1015 Too Many Requests",
      now,
    );

    expect(getManagedTunnelRecoveryCooldown(state, now + 1_000)).toEqual(cooldown);
    expect(managedTunnelRecoveryCooldownDetail(cooldown, now + 1_000)).toContain("bridgectl call arm");
    expect(getManagedTunnelRecoveryCooldown(state, cooldown.until + 1)).toBeNull();
  });
});

function createSurface(now = Date.now()): RealtimeCallSurfaceRecord {
  return {
    armed: true,
    armedAt: now,
    armedBy: "test",
    expiresAt: now + 60_000,
    lastActivityAt: now,
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
    launchTokenExpiresAt: now + 60_000,
    tunnelMode: "managed-quick-cloudflared",
    tunnelPid: 111,
    tunnelUrl: "https://old-subdomain.trycloudflare.com",
    tunnelStartedAt: now,
  };
}

describe("applyManagedTunnelHandle", () => {
  test("keeps the existing launch token when the managed tunnel endpoint is unchanged", () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-tunnel-"));
    tempRoots.push(root);
    const config = createConfig(root);
    const now = Date.now();
    const surface = createSurface(now);

    const next = applyManagedTunnelHandle(config, surface, {
      pid: 111,
      url: "https://old-subdomain.trycloudflare.com/",
      startedAt: now + 5_000,
    }, { now: now + 5_000 });

    expect(next.launchTokenId).toBe(surface.launchTokenId);
    expect(next.tunnelPid).toBe(111);
    expect(next.tunnelUrl).toBe("https://old-subdomain.trycloudflare.com");
  });

  test("mints a fresh launch token when the managed tunnel endpoint changes", () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-tunnel-"));
    tempRoots.push(root);
    const config = createConfig(root);
    const now = Date.now();
    const surface = createSurface(now);

    const next = applyManagedTunnelHandle(config, surface, {
      pid: 222,
      url: "https://new-subdomain.trycloudflare.com/",
      startedAt: now + 5_000,
    }, { now: now + 5_000 });

    expect(next.launchTokenId).not.toBe(surface.launchTokenId);
    expect(next.launchTokenId).not.toBeNull();
    expect(next.tunnelPid).toBe(222);
    expect(next.tunnelUrl).toBe("https://new-subdomain.trycloudflare.com");
  });
});
