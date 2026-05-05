import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test, vi } from "vitest";

import { defaultBranding } from "../src/core/config.js";
import type { BridgeConfig } from "../src/core/config.js";
import { probeRealtimePublicSurface, waitForRealtimePublicSurfaceReady } from "../src/core/realtime/public-surface.js";
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

function createSurface(): RealtimeCallSurfaceRecord {
  const now = Date.now();
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
    tunnelMode: "static-public-url",
    tunnelPid: null,
    tunnelUrl: null,
    tunnelStartedAt: null,
  };
}

describe("probeRealtimePublicSurface", () => {
  test("reports a dead public origin instead of ready", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-public-surface-"));
    tempRoots.push(root);
    const config = createConfig(root);
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      const error = new Error("fetch failed") as Error & {
        cause?: { code: string };
      };
      error.cause = { code: "ENOTFOUND" };
      throw error;
    });

    const result = await probeRealtimePublicSurface(config, createSurface(), {
      fetchImpl,
      timeoutMs: 10,
    });

    expect(result.ready).toBe(false);
    expect(result.detail).toContain("DNS lookup failed");
  });

  test("requires both public health and Mini App HTML", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-public-surface-"));
    tempRoots.push(root);
    const config = createConfig(root);
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response("<html><body>unexpected</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }));

    const result = await probeRealtimePublicSurface(config, createSurface(), {
      fetchImpl,
      timeoutMs: 10,
    });

    expect(result.ready).toBe(false);
    expect(result.detail).toContain("unexpected content");
  });

  test("accepts a reachable public health endpoint and Mini App", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-public-surface-"));
    tempRoots.push(root);
    const config = createConfig(root);
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response("<html><body>Bridge Realtime<button id=\"startBtn\"></button></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }));

    const result = await probeRealtimePublicSurface(config, createSurface(), {
      fetchImpl,
      timeoutMs: 10,
    });

    expect(result.ready).toBe(true);
    expect(result.launchUrl).toBe("https://example.com/miniapp?bridgeId=bridge&launch=launch-token");
  });

  test("uses the authenticated Mini App health probe when a control secret is available", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-public-surface-"));
    tempRoots.push(root);
    const config = createConfig(root);
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));

    const result = await probeRealtimePublicSurface(config, createSurface(), {
      fetchImpl,
      timeoutMs: 10,
      extraHeaders: { "x-bridge-secret": "secret" },
      preferControlMiniAppProbe: true,
    });

    expect(result.ready).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("https://example.com/healthz/miniapp?bridgeId=bridge&launch=launch-token");
    expect(fetchImpl.mock.calls[1]?.[1]?.headers).toEqual(expect.any(Headers));
    expect(new Headers(fetchImpl.mock.calls[1]?.[1]?.headers).get("x-bridge-secret")).toBe("secret");
  });

  test("waits for quick-tunnel DNS warmup before declaring the surface dead", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-public-surface-"));
    tempRoots.push(root);
    const config = createConfig(root);
    let attempt = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      attempt += 1;
      if (attempt <= 2) {
        const error = new Error("fetch failed") as Error & { cause?: { code: string } };
        error.cause = { code: "ENOTFOUND" };
        throw error;
      }
      if (attempt === 3) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("<html><body>Bridge Realtime<button id=\"startBtn\"></button></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    });

    const result = await waitForRealtimePublicSurfaceReady(config, createSurface(), {
      fetchImpl,
      timeoutMs: 10,
      deadlineMs: 250,
      intervalMs: 0,
    });

    expect(result.ready).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});
