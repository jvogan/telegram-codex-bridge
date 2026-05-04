import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter } from "node:path";
import { dirname, join, resolve } from "node:path";
import { config as dotenvConfig } from "dotenv";
import { parse } from "smol-toml";
import { z } from "zod";

import {
  BRIDGE_MODES,
  PROVIDERS_BY_MODALITY,
} from "./types.js";
import { missingBridgeConfigMessage, missingCodexBinaryMessage, missingTelegramBotTokenMessage } from "./onboarding-messages.js";
import type {
  BridgeMode,
  FallbackLaneRouting,
  MediaDefaults,
  ProviderFallbacks,
  ProviderId,
  RealtimeSurfaceMode,
  RealtimeTunnelMode,
} from "./types.js";

const bridgeModeSchema = z.enum(BRIDGE_MODES);
const fallbackLaneRoutingSchema = z.enum(["when_desktop_busy_safe"]);
const asrProviderIdSchema = z.enum(PROVIDERS_BY_MODALITY.asr);
const ttsProviderIdSchema = z.enum(PROVIDERS_BY_MODALITY.tts);
const imageProviderIdSchema = z.enum(PROVIDERS_BY_MODALITY.image_generation);
const terminalLaneBackendSchema = z.enum(["auto", "tmux", "iterm2", "terminal-app"]);
const terminalLaneProfileSchema = z.enum(["public-safe", "power-user"]);
const terminalLaneSandboxSchema = z.enum(["read-only", "workspace-write"]);
const terminalLaneApprovalPolicySchema = z.enum(["never", "on-request"]);

export const defaultBranding = {
  product_name: "Telegram Codex Bridge",
  bot_name: "BridgeBot",
  bot_description: "Codex-powered Telegram engineering bot.",
  bot_short_description: "Codex engineering bot with text, file, image, and voice support.",
  realtime_badge: "Bridge Realtime",
  realtime_call_title: "Bridge Call",
  realtime_speaker_name: "Bridge",
  desktop_notification_title: "Bridge",
  invite_ready_text: "Bridge is ready to talk live.",
} as const;

const brandingSchema = z.object({
  product_name: z.string().min(1).default(defaultBranding.product_name),
  bot_name: z.string().min(1).default(defaultBranding.bot_name),
  bot_description: z.string().min(1).default(defaultBranding.bot_description),
  bot_short_description: z.string().min(1).default(defaultBranding.bot_short_description),
  realtime_badge: z.string().min(1).default(defaultBranding.realtime_badge),
  realtime_call_title: z.string().min(1).default(defaultBranding.realtime_call_title),
  realtime_speaker_name: z.string().min(1).default(defaultBranding.realtime_speaker_name),
  desktop_notification_title: z.string().min(1).default(defaultBranding.desktop_notification_title),
  invite_ready_text: z.string().min(1).default(defaultBranding.invite_ready_text),
}).default(defaultBranding);

const configSchema = z.object({
  telegram: z.object({
    authorized_chat_id: z.string().min(1),
    transport: z.literal("long-polling").default("long-polling"),
    poll_timeout_seconds: z.number().int().positive().default(30),
    long_poll_limit: z.number().int().positive().max(100).default(25),
    clear_webhook_on_start: z.boolean().default(false),
  }),
  bridge: z.object({
    mode: bridgeModeSchema.default("autonomous-thread"),
    codex_binary: z.string().default(""),
    fallback_lane: z.object({
      enabled: z.boolean().default(false),
      routing: fallbackLaneRoutingSchema.default("when_desktop_busy_safe"),
      allow_workspace_writes: z.boolean().default(false),
      app_server_port: z.number().int().positive().optional(),
      workdir: z.string().optional(),
    }).optional(),
  }).default({
    mode: "autonomous-thread",
    codex_binary: "",
  }),
  terminal_lane: z.object({
    enabled: z.boolean().default(false),
    backend: terminalLaneBackendSchema.default("tmux"),
    session_name: z.string().min(1).default("telegram-codex-bridge-terminal"),
    workdir: z.string().optional(),
    codex_command: z.string().default(""),
    profile: terminalLaneProfileSchema.default("public-safe"),
    sandbox: terminalLaneSandboxSchema.default("read-only"),
    approval_policy: terminalLaneApprovalPolicySchema.default("never"),
    model: z.string().default("gpt-5.5"),
    reasoning_effort: z.enum(["low", "medium", "high", "xhigh"]).default("low"),
    codex_profile: z.string().optional(),
    daemon_owned: z.boolean().default(true),
    allow_user_owned_sessions: z.boolean().default(false),
    allow_terminal_control: z.boolean().default(false),
  }).default({
    enabled: false,
    backend: "tmux",
    session_name: "telegram-codex-bridge-terminal",
    codex_command: "",
    profile: "public-safe",
    sandbox: "read-only",
    approval_policy: "never",
    model: "gpt-5.5",
    reasoning_effort: "low",
    daemon_owned: true,
    allow_user_owned_sessions: false,
    allow_terminal_control: false,
  }),
  codex: z.object({
    workdir: z.string().default(""),
    approval_policy: z.enum(["untrusted", "on-failure", "on-request", "never"]).default("on-request"),
    sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
    app_server_port: z.number().int().positive().default(8765),
    model: z.string().default(""),
  }),
  storage: z.object({
    root: z.string().default("./.bridge-data"),
    retention_days: z.number().int().nonnegative().default(14),
  }).default({
    root: "./.bridge-data",
    retention_days: 14,
  }),
  branding: brandingSchema,
  presentation: z.object({
    demo_practice_mode: z.boolean().default(false),
  }).default({
    demo_practice_mode: false,
  }),
  providers: z.object({
    defaults: z.object({
      asr: asrProviderIdSchema.default("openai"),
      tts: ttsProviderIdSchema.default("openai"),
      image_generation: imageProviderIdSchema.default("openai"),
    }),
    fallbacks: z.object({
      asr: z.array(asrProviderIdSchema).default(["openai"]),
      tts: z.array(ttsProviderIdSchema).default(["elevenlabs"]),
      image_generation: z.array(imageProviderIdSchema).default(["google"]),
    }),
    openai: z.object({
      enabled: z.boolean().default(true),
      asr_model: z.string().default("gpt-4o-transcribe"),
      tts_model: z.string().default("gpt-4o-mini-tts"),
      tts_voice: z.string().default("marin"),
      tts_response_format: z.string().default("wav"),
      image_model: z.string().default("gpt-image-1"),
      image_size: z.string().default("1024x1024"),
    }),
    elevenlabs: z.object({
      enabled: z.boolean().default(true),
      tts_model: z.string().default("eleven_multilingual_v2"),
      tts_voice_id: z.string().default(""),
      tts_output_format: z.string().default("mp3_44100_128"),
    }),
    google: z.object({
      enabled: z.boolean().default(true),
      image_model: z.string().default("imagen-4.0-generate-001"),
      image_aspect_ratio: z.string().default("1:1"),
    }),
  }),
  experimental: z.object({
    enable_shadow_window: z.boolean().default(false),
  }).default({
    enable_shadow_window: false,
  }),
  realtime: z.object({
    enabled: z.boolean().default(false),
    bridge_id: z.string().default("bridge"),
    public_url: z.string().default(""),
    control_url: z.string().default(""),
    surface_mode: z.enum(["manual-arm"]).default("manual-arm"),
    tunnel_mode: z.enum(["managed-quick-cloudflared", "static-public-url"]).optional(),
    tunnel_bin: z.string().default("cloudflared"),
    gateway_host: z.string().default("127.0.0.1"),
    gateway_port: z.number().int().positive().default(8890),
    model: z.string().default("gpt-realtime"),
    transcription_model: z.string().default("gpt-4o-mini-transcribe"),
    voice: z.string().default("marin"),
    startup_timeout_ms: z.number().int().positive().default(45_000),
    idle_warning_ms: z.number().int().positive().default(120_000),
    idle_timeout_ms: z.number().int().positive().default(600_000),
    auto_disarm_idle_ms: z.number().int().positive().default(300_000),
    launch_token_ttl_ms: z.number().int().positive().default(600_000),
    bootstrap_rate_limit_window_ms: z.number().int().positive().default(600_000),
    bootstrap_rate_limit_per_ip: z.number().int().positive().default(5),
    bootstrap_rate_limit_per_bridge: z.number().int().positive().default(10),
    bootstrap_rate_limit_per_user: z.number().int().positive().default(3),
    max_call_ms: z.number().int().positive().default(600_000),
    max_daily_call_ms: z.number().int().positive().default(1_800_000),
    summary_model: z.string().default("gpt-4.1-mini"),
  }).default({
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
  }),
});

export type BridgeConfig = z.infer<typeof configSchema> & {
  configPath: string;
  repoRoot: string;
  storageRoot: string;
  bridgeModeExplicit: boolean;
};

export type BridgeBranding = z.infer<typeof brandingSchema>;

export interface BridgeFallbackLaneConfig {
  enabled: boolean;
  routing: FallbackLaneRouting;
  allow_workspace_writes: boolean;
  app_server_port: number;
  workdir?: string;
}

export interface BridgeEnv {
  telegramBotToken: string | null;
  openaiApiKey: string | null;
  elevenlabsApiKey: string | null;
  googleGenAiApiKey: string | null;
  realtimeControlSecret: string | null;
}

interface CodexBinaryResolutionOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  pathEntries?: string[];
  exists?: (path: string) => boolean;
}

export function resolveConfigPath(explicitPath?: string): string {
  if (explicitPath) {
    return resolve(explicitPath);
  }
  const fromEnv = process.env.BRIDGE_CONFIG_PATH;
  if (fromEnv) {
    return resolve(fromEnv);
  }
  return resolve(process.cwd(), "bridge.config.toml");
}

export function loadConfig(explicitPath?: string): BridgeConfig {
  const configPath = resolveConfigPath(explicitPath);
  if (!existsSync(configPath)) {
    throw new Error(missingBridgeConfigMessage(configPath));
  }
  const raw = parse(readFileSync(configPath, "utf8"));
  const parsed = configSchema.parse(raw);
  const resolvedTunnelMode: RealtimeTunnelMode = parsed.realtime.tunnel_mode
    ?? (parsed.realtime.public_url ? "static-public-url" : "managed-quick-cloudflared");
  const resolvedSurfaceMode: RealtimeSurfaceMode = parsed.realtime.surface_mode ?? "manual-arm";
  const repoRoot = dirname(configPath);
  const bridgeModeExplicit = Boolean(
    raw
    && typeof raw === "object"
    && "bridge" in raw
    && raw.bridge
    && typeof raw.bridge === "object"
    && "mode" in raw.bridge,
  );
  return {
    ...parsed,
    realtime: {
      ...parsed.realtime,
      surface_mode: resolvedSurfaceMode,
      tunnel_mode: resolvedTunnelMode,
    },
    configPath,
    repoRoot,
    storageRoot: resolve(repoRoot, parsed.storage.root),
    bridgeModeExplicit,
  };
}

export function loadBridgeEnv(config: BridgeConfig): BridgeEnv {
  const envFiles = [
    resolve(config.repoRoot, ".env.local"),
    resolve(config.repoRoot, ".env"),
  ];
  for (const path of envFiles) {
    if (existsSync(path)) {
      dotenvConfig({ path, override: false });
    }
  }
  return {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? null,
    openaiApiKey: process.env.OPENAI_API_KEY ?? null,
    elevenlabsApiKey: process.env.ELEVENLABS_API_KEY ?? null,
    googleGenAiApiKey: process.env.GOOGLE_GENAI_API_KEY ?? null,
    realtimeControlSecret: process.env.REALTIME_CONTROL_SECRET ?? null,
  };
}

export function defaultBridgeMode(config: BridgeConfig): BridgeMode {
  return config.bridgeModeExplicit ? config.bridge.mode : "autonomous-thread";
}

export function resolveFallbackLaneConfig(config: BridgeConfig): BridgeFallbackLaneConfig {
  const fallback = config.bridge.fallback_lane;
  const workdir = fallback?.workdir?.trim();
  return {
    enabled: fallback?.enabled ?? false,
    routing: fallback?.routing ?? "when_desktop_busy_safe",
    allow_workspace_writes: fallback?.allow_workspace_writes ?? false,
    app_server_port: fallback?.app_server_port ?? config.codex.app_server_port + 1,
    ...(workdir ? { workdir } : {}),
  };
}

function knownCodexBinaryDefaults(platformName: NodeJS.Platform): string[] {
  if (platformName === "darwin") {
    return [
      "/Applications/Codex.app/Contents/Resources/codex",
    ];
  }
  return [];
}

function executableExists(path: string, exists: (path: string) => boolean): boolean {
  try {
    return exists(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

export function resolveCodexBinary(
  config: BridgeConfig,
  options: CodexBinaryResolutionOptions = {},
): string | null {
  const env = options.env ?? process.env;
  const platformName = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const pathEntries = options.pathEntries
    ?? (env.PATH ? env.PATH.split(delimiter).filter(Boolean) : []);

  const explicit = config.bridge.codex_binary.trim();
  if (explicit && executableExists(explicit, exists)) {
    return explicit;
  }

  const fromEnv = env.CODEX_BINARY?.trim();
  if (fromEnv && executableExists(fromEnv, exists)) {
    return fromEnv;
  }

  for (const entry of pathEntries) {
    const candidate = join(entry, platformName === "win32" ? "codex.cmd" : "codex");
    if (candidate && executableExists(candidate, exists)) {
      return candidate;
    }
    if (platformName === "win32") {
      for (const alt of ["codex.exe", "codex.bat"]) {
        const winCandidate = join(entry, alt);
        if (executableExists(winCandidate, exists)) {
          return winCandidate;
        }
      }
    }
  }

  for (const candidate of knownCodexBinaryDefaults(platformName)) {
    if (executableExists(candidate, exists)) {
      return candidate;
    }
  }

  return null;
}

export function requireCodexBinary(
  config: BridgeConfig,
  options: CodexBinaryResolutionOptions = {},
): string {
  const resolved = resolveCodexBinary(config, options);
  if (!resolved) {
    throw new Error(missingCodexBinaryMessage());
  }
  return resolved;
}

export function requireTelegramBotToken(env: BridgeEnv): string {
  if (!env.telegramBotToken) {
    throw new Error(missingTelegramBotTokenMessage());
  }
  return env.telegramBotToken;
}

export function normalizeProviderChain(
  override: ProviderId | null,
  defaults: MediaDefaults,
  fallbacks: ProviderFallbacks,
  modality: keyof MediaDefaults,
): ProviderId[] {
  const preferred = override ?? defaults[modality];
  const chain = [preferred, ...fallbacks[modality]];
  return [...new Set(chain)];
}
