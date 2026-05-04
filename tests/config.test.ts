import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "vitest";

import {
  defaultBranding,
  defaultBridgeMode,
  loadBridgeEnv,
  loadConfig,
  normalizeProviderChain,
  requireCodexBinary,
  requireTelegramBotToken,
  resolveCodexBinary,
} from "../src/core/config.js";
import { PROVIDERS_BY_MODALITY } from "../src/core/types.js";

const tempRoots: string[] = [];
const originalEnv = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  REALTIME_CONTROL_SECRET: process.env.REALTIME_CONTROL_SECRET,
};

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
  process.env.TELEGRAM_BOT_TOKEN = originalEnv.TELEGRAM_BOT_TOKEN;
  process.env.OPENAI_API_KEY = originalEnv.OPENAI_API_KEY;
  process.env.REALTIME_CONTROL_SECRET = originalEnv.REALTIME_CONTROL_SECRET;
});

function writeConfig(contents: string): string {
  const root = mkdtempSync(join(tmpdir(), "telegram-codex-bridge-config-"));
  tempRoots.push(root);
  const path = join(root, "bridge.config.toml");
  writeFileSync(path, contents, "utf8");
  return path;
}

describe("normalizeProviderChain", () => {
  test("keeps the shared public provider matrix stable", () => {
    expect(PROVIDERS_BY_MODALITY).toEqual({
      asr: ["openai"],
      tts: ["openai", "elevenlabs"],
      image_generation: ["openai", "google"],
    });
  });

  test("places the override first and removes duplicates", () => {
    const chain = normalizeProviderChain(
      "elevenlabs",
      {
        asr: "openai",
        tts: "openai",
        image_generation: "openai",
      },
      {
        asr: ["openai"],
        tts: ["openai", "elevenlabs"],
        image_generation: ["google"],
      },
      "tts",
    );

    expect(chain).toEqual(["elevenlabs", "openai"]);
  });

  test("keeps autonomous-thread as the migration default when bridge.mode is absent", () => {
    const configPath = writeConfig(`
[telegram]
authorized_chat_id = "123"

[codex]
workdir = "/tmp/workdir"

[storage]
root = "./.bridge-data"

[providers.defaults]
asr = "openai"
tts = "openai"
image_generation = "openai"

[providers.fallbacks]
asr = ["openai"]
tts = ["elevenlabs"]
image_generation = ["google"]

[providers.openai]
enabled = true

[providers.elevenlabs]
enabled = true

[providers.google]
enabled = true
`);

    const config = loadConfig(configPath);
    expect(defaultBridgeMode(config)).toBe("autonomous-thread");
    expect(config.branding).toEqual(defaultBranding);
  });

  test("honors an explicit shared-thread mode", () => {
    const configPath = writeConfig(`
[telegram]
authorized_chat_id = "123"

[bridge]
mode = "shared-thread-resume"

[codex]
workdir = "/tmp/workdir"

[storage]
root = "./.bridge-data"

[providers.defaults]
asr = "openai"
tts = "openai"
image_generation = "openai"

[providers.fallbacks]
asr = ["openai"]
tts = ["elevenlabs"]
image_generation = ["google"]

[providers.openai]
enabled = true

[providers.elevenlabs]
enabled = true

[providers.google]
enabled = true
`);

    const config = loadConfig(configPath);
    expect(defaultBridgeMode(config)).toBe("shared-thread-resume");
  });

  test("defaults storage retention to 14 days", () => {
    const configPath = writeConfig(`
[telegram]
authorized_chat_id = "123"

[codex]
workdir = "/tmp/workdir"

[storage]
root = "./.bridge-data"

[providers.defaults]
asr = "openai"
tts = "openai"
image_generation = "openai"

[providers.fallbacks]
asr = ["openai"]
tts = ["elevenlabs"]
image_generation = ["google"]

[providers.openai]
enabled = true

[providers.elevenlabs]
enabled = true

[providers.google]
enabled = true
`);

    const config = loadConfig(configPath);
    expect(config.storage.retention_days).toBe(14);
  });

  test("keeps demo practice presentation mode off by default", () => {
    const configPath = writeConfig(`
[telegram]
authorized_chat_id = "123"

[codex]
workdir = "/tmp/workdir"

[storage]
root = "./.bridge-data"

[providers.defaults]
asr = "openai"
tts = "openai"
image_generation = "openai"

[providers.fallbacks]
asr = ["openai"]
tts = ["elevenlabs"]
image_generation = ["google"]

[providers.openai]
enabled = true

[providers.elevenlabs]
enabled = true

[providers.google]
enabled = true
`);

    const config = loadConfig(configPath);
    expect(config.presentation.demo_practice_mode).toBe(false);
  });

  test("allows terminal superpowers only through explicit config", () => {
    const configPath = writeConfig(`
[telegram]
authorized_chat_id = "123"

[terminal_lane]
enabled = true
backend = "iterm2"
profile = "power-user"
sandbox = "workspace-write"
approval_policy = "on-request"
daemon_owned = false
allow_user_owned_sessions = true
allow_terminal_control = true

[codex]
workdir = "/tmp/workdir"

[storage]
root = "./.bridge-data"

[providers.defaults]
asr = "openai"
tts = "openai"
image_generation = "openai"

[providers.fallbacks]
asr = ["openai"]
tts = ["elevenlabs"]
image_generation = ["google"]

[providers.openai]
enabled = true

[providers.elevenlabs]
enabled = true

[providers.google]
enabled = true
`);

    const config = loadConfig(configPath);
    expect(config.terminal_lane).toMatchObject({
      enabled: true,
      backend: "iterm2",
      profile: "power-user",
      sandbox: "workspace-write",
      approval_policy: "on-request",
      daemon_owned: false,
      allow_user_owned_sessions: true,
      allow_terminal_control: true,
    });
  });

  test("defaults realtime startup timeout to 45 seconds", () => {
    const configPath = writeConfig(`
[telegram]
authorized_chat_id = "123"

[codex]
workdir = "/tmp/workdir"

[storage]
root = "./.bridge-data"

[providers.defaults]
asr = "openai"
tts = "openai"
image_generation = "openai"

[providers.fallbacks]
asr = ["openai"]
tts = ["elevenlabs"]
image_generation = ["google"]

[providers.openai]
enabled = true

[providers.elevenlabs]
enabled = true

[providers.google]
enabled = true

[realtime]
enabled = true
`);

    const config = loadConfig(configPath);
    expect(config.realtime.startup_timeout_ms).toBe(45_000);
  });

  test("leaves codex_binary blank by default so the runtime can auto-detect it", () => {
    const configPath = writeConfig(`
[telegram]
authorized_chat_id = "123"

[codex]
workdir = "/tmp/workdir"

[storage]
root = "./.bridge-data"

[providers.defaults]
asr = "openai"
tts = "openai"
image_generation = "openai"

[providers.fallbacks]
asr = ["openai"]
tts = ["elevenlabs"]
image_generation = ["google"]

[providers.openai]
enabled = true

[providers.elevenlabs]
enabled = true

[providers.google]
enabled = true
`);

    const config = loadConfig(configPath);
    expect(config.bridge.codex_binary).toBe("");
  });

  test("loads bridge env from the repo-local .env file", () => {
    const configPath = writeConfig(`
[telegram]
authorized_chat_id = "123"

[codex]
workdir = "/tmp/workdir"

[storage]
root = "./.bridge-data"

[providers.defaults]
asr = "openai"
tts = "openai"
image_generation = "openai"

[providers.fallbacks]
asr = ["openai"]
tts = ["elevenlabs"]
image_generation = ["google"]

[providers.openai]
enabled = true

[providers.elevenlabs]
enabled = true

[providers.google]
enabled = true
`);
    const root = tempRoots[tempRoots.length - 1]!;
    writeFileSync(join(root, ".env"), [
      "TELEGRAM_BOT_TOKEN=test-bot-token",
      "OPENAI_API_KEY=test-openai-key",
      "REALTIME_CONTROL_SECRET=test-control-secret",
    ].join("\n"));
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.OPENAI_API_KEY;
    delete process.env.REALTIME_CONTROL_SECRET;

    const config = loadConfig(configPath);
    const env = loadBridgeEnv(config);

    expect(env.telegramBotToken).toBe("test-bot-token");
    expect(env.openaiApiKey).toBe("test-openai-key");
    expect(env.realtimeControlSecret).toBe("test-control-secret");
  });

  test("prefers an explicit codex_binary override when it exists", () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-binary-"));
    tempRoots.push(root);
    const binaryPath = join(root, "codex-custom");
    writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(binaryPath, 0o755);
    const configPath = writeConfig(`
[telegram]
authorized_chat_id = "123"

[bridge]
codex_binary = "${binaryPath}"

[codex]
workdir = "/tmp/workdir"

[storage]
root = "./.bridge-data"

[providers.defaults]
asr = "openai"
tts = "openai"
image_generation = "openai"

[providers.fallbacks]
asr = ["openai"]
tts = ["elevenlabs"]
image_generation = ["google"]

[providers.openai]
enabled = true

[providers.elevenlabs]
enabled = true

[providers.google]
enabled = true
`);

    const config = loadConfig(configPath);
    expect(resolveCodexBinary(config)).toBe(binaryPath);
  });

  test("falls back to CODEX_BINARY and PATH when bridge.codex_binary is unset", () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-binary-"));
    tempRoots.push(root);
    const pathDir = join(root, "bin");
    mkdirSync(pathDir, { recursive: true });
    const pathBinary = join(pathDir, "codex");
    writeFileSync(pathBinary, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(pathBinary, 0o755);
    const configPath = writeConfig(`
[telegram]
authorized_chat_id = "123"

[codex]
workdir = "/tmp/workdir"

[storage]
root = "./.bridge-data"

[providers.defaults]
asr = "openai"
tts = "openai"
image_generation = "openai"

[providers.fallbacks]
asr = ["openai"]
tts = ["elevenlabs"]
image_generation = ["google"]

[providers.openai]
enabled = true

[providers.elevenlabs]
enabled = true

[providers.google]
enabled = true
`);

    const config = loadConfig(configPath);

    expect(resolveCodexBinary(config, {
      env: { ...process.env, CODEX_BINARY: pathBinary },
      pathEntries: [],
    })).toBe(pathBinary);

    expect(resolveCodexBinary(config, {
      env: { ...process.env, CODEX_BINARY: "" },
      pathEntries: [pathDir],
    })).toBe(pathBinary);
  });

  test("explains how to configure Codex Desktop when no binary can be found", () => {
    const configPath = writeConfig(`
[telegram]
authorized_chat_id = "123"

[codex]
workdir = "/tmp/workdir"

[storage]
root = "./.bridge-data"

[providers.defaults]
asr = "openai"
tts = "openai"
image_generation = "openai"

[providers.fallbacks]
asr = ["openai"]
tts = ["elevenlabs"]
image_generation = ["google"]

[providers.openai]
enabled = true

[providers.elevenlabs]
enabled = true

[providers.google]
enabled = true
`);
    const config = loadConfig(configPath);

    expect(() => requireCodexBinary(config, {
      env: { ...process.env, CODEX_BINARY: "" },
      pathEntries: [],
      platform: "linux",
    })).toThrow(
      "Codex Desktop could not be found automatically. Set bridge.codex_binary in bridge.config.toml, or set CODEX_BINARY, or make `codex` available on PATH before starting the bridge daemon.",
    );
  });

  test("rejects unsupported providers for a modality", () => {
    const configPath = writeConfig(`
[telegram]
authorized_chat_id = "123"

[codex]
workdir = "/tmp/workdir"

[storage]
root = "./.bridge-data"

[providers.defaults]
asr = "openai"
tts = "google"
image_generation = "openai"

[providers.fallbacks]
asr = ["openai"]
tts = ["elevenlabs"]
image_generation = ["google"]

[providers.openai]
enabled = true

[providers.elevenlabs]
enabled = true

[providers.google]
enabled = true
`);

    expect(() => loadConfig(configPath)).toThrow();
  });

  test("explains how to create bridge.config.toml when the config file is missing", () => {
    const missingPath = join(tmpdir(), "telegram-codex-bridge-missing", "bridge.config.toml");
    expect(() => loadConfig(missingPath)).toThrow(
      `Bridge config not found at ${missingPath}. Copy bridge.config.example.toml to bridge.config.toml first.`,
    );
  });

  test("explains how to provide TELEGRAM_BOT_TOKEN", () => {
    expect(() => requireTelegramBotToken({
      telegramBotToken: null,
      openaiApiKey: null,
      elevenlabsApiKey: null,
      googleGenAiApiKey: null,
      realtimeControlSecret: null,
    })).toThrow(
      "TELEGRAM_BOT_TOKEN is required. Copy .env.example to .env and set TELEGRAM_BOT_TOKEN before running bridge commands.",
    );
  });
});
