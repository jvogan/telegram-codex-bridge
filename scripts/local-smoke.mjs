import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse as parseDotenv } from "dotenv";
import { parse as parseToml } from "smol-toml";
import { redactSmokeJson, redactSmokeValue } from "./smoke-redaction.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

const DIST_BRIDGECTL = join(repoRoot, "dist", "bin", "bridgectl.js");
const DIST_GATEWAY = join(repoRoot, "dist", "bin", "realtime-gateway.js");
const ALLOWED_ENV_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "OPENAI_API_KEY",
  "ELEVENLABS_API_KEY",
  "GOOGLE_GENAI_API_KEY",
  "REALTIME_CONTROL_SECRET",
];
const CAPABILITY_PREFIXES = [
  "TELEGRAM_BOT_TOKEN:",
  "Telegram daemon:",
  "Desktop thread binding:",
  "Realtime calls:",
  "Terminal lane:",
  "Selected terminal backend:",
  "OPENAI_API_KEY:",
  "ELEVENLABS_API_KEY:",
  "GOOGLE_GENAI_API_KEY:",
  "REALTIME_CONTROL_SECRET:",
];

function usage() {
  console.log([
    "Usage:",
    "  npm run smoke:local -- --env-file /path/to/.env [--config-file /path/to/bridge.config.toml]",
    "  npm run smoke:local -- --env-file /path/to/.env --authorized-chat-id 123456789",
    "",
    "Options:",
    "  --env-file PATH             Source .env file to borrow local secrets from",
    "  --config-file PATH          Optional source bridge config to copy authorized_chat_id from",
    "  --authorized-chat-id ID     Override the authorized chat id used in the temp config",
    "  --workdir PATH              Workdir for the temp config (defaults to this repo)",
    "  --gateway-port N            Realtime gateway port override",
    "  --app-server-port N         App server port override",
    "  --keep-temp                 Keep the temp config directory for inspection",
    "  --skip-gateway              Skip the realtime-gateway smoke checks",
  ].join("\n"));
}

function toTomlString(value) {
  return JSON.stringify(String(value));
}

function normalizeNonEmpty(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseAuthorizedChatId(text) {
  const parsed = parseToml(text);
  const value = parsed?.telegram?.authorized_chat_id;
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return null;
}

async function findAvailablePort(startPort) {
  let port = startPort;
  for (let attempt = 0; attempt < 50; attempt += 1, port += 1) {
    const available = await new Promise(resolveAvailable => {
      const server = createServer();
      server.once("error", () => {
        resolveAvailable(false);
      });
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolveAvailable(true));
      });
    });
    if (available) {
      return port;
    }
  }
  throw new Error(`Could not find a free port starting at ${startPort}.`);
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        rejectPromise(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

function logSafe(value = "") {
  console.log(redactSmokeValue(value));
}

function logJsonSafe(value) {
  console.log(JSON.stringify(redactSmokeJson(value)));
}

async function waitForHealthz(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        return await response.json();
      }
    } catch {
      // Retry until timeout.
    }
    await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
  }
  throw new Error(`Timed out waiting for gateway readiness at ${url}.`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      "env-file": { type: "string" },
      "config-file": { type: "string" },
      "authorized-chat-id": { type: "string" },
      workdir: { type: "string" },
      "gateway-port": { type: "string" },
      "app-server-port": { type: "string" },
      "keep-temp": { type: "boolean" },
      "skip-gateway": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    usage();
    return;
  }

  const envFile = normalizeNonEmpty(values["env-file"]);
  if (!envFile) {
    usage();
    throw new Error("--env-file is required.");
  }
  const envPath = resolve(envFile);
  if (!existsSync(envPath)) {
    throw new Error(`Env file not found: ${envPath}`);
  }
  if (!existsSync(DIST_BRIDGECTL) || !existsSync(DIST_GATEWAY)) {
    throw new Error("Built artifacts are missing. Run npm run build first.");
  }

  const envSource = parseDotenv(await readFile(envPath, "utf8"));
  const selectedEnv = {};
  for (const key of ALLOWED_ENV_KEYS) {
    const value = normalizeNonEmpty(envSource[key]);
    if (value) {
      selectedEnv[key] = value;
    }
  }
  if (!selectedEnv.TELEGRAM_BOT_TOKEN) {
    throw new Error(`TELEGRAM_BOT_TOKEN is missing in ${envPath}`);
  }

  let authorizedChatId = normalizeNonEmpty(values["authorized-chat-id"]);
  const configFile = normalizeNonEmpty(values["config-file"]);
  if (!authorizedChatId && configFile) {
    const configPath = resolve(configFile);
    if (!existsSync(configPath)) {
      throw new Error(`Config file not found: ${configPath}`);
    }
    authorizedChatId = parseAuthorizedChatId(await readFile(configPath, "utf8"));
  }
  if (!authorizedChatId) {
    authorizedChatId = "test-chat";
  }

  const workdir = resolve(normalizeNonEmpty(values.workdir) ?? repoRoot);
  const gatewayPort = Number.parseInt(normalizeNonEmpty(values["gateway-port"]) ?? "", 10)
    || await findAvailablePort(8895);
  const appServerPort = Number.parseInt(normalizeNonEmpty(values["app-server-port"]) ?? "", 10)
    || await findAvailablePort(8877);
  const keepTemp = Boolean(values["keep-temp"]);
  const skipGateway = Boolean(values["skip-gateway"]);

  const tempRoot = await mkdtemp(join(tmpdir(), "telegram-codex-bridge-smoke-"));
  const tempEnvPath = join(tempRoot, ".env");
  const tempConfigPath = join(tempRoot, "bridge.config.toml");
  const tempEnvText = ALLOWED_ENV_KEYS
    .filter(key => selectedEnv[key])
    .map(key => `${key}=${selectedEnv[key]}`)
    .join("\n");

  const tempConfigText = [
    "[telegram]",
    `authorized_chat_id = ${toTomlString(authorizedChatId)}`,
    'transport = "long-polling"',
    "poll_timeout_seconds = 30",
    "long_poll_limit = 25",
    "clear_webhook_on_start = false",
    "",
    "[bridge]",
    'mode = "shared-thread-resume"',
    'codex_binary = ""',
    "",
    "[codex]",
    `workdir = ${toTomlString(workdir)}`,
    'approval_policy = "on-request"',
    'sandbox = "workspace-write"',
    `app_server_port = ${appServerPort}`,
    'model = ""',
    "",
    "[storage]",
    'root = "./.bridge-data"',
    "retention_days = 14",
    "",
    "[branding]",
    'product_name = "Telegram Codex Bridge"',
    'bot_name = "BridgeBot"',
    'bot_description = "Codex-powered Telegram engineering bot."',
    'bot_short_description = "Codex engineering bot with text, file, image, and voice support."',
    'realtime_badge = "Bridge Realtime"',
    'realtime_call_title = "Bridge Call"',
    'realtime_speaker_name = "Bridge"',
    'desktop_notification_title = "Bridge"',
    'invite_ready_text = "Bridge is ready to talk live."',
    "",
    "[providers.defaults]",
    'asr = "openai"',
    'tts = "openai"',
    'image_generation = "openai"',
    "",
    "[providers.fallbacks]",
    'asr = ["openai"]',
    'tts = ["elevenlabs"]',
    'image_generation = ["google"]',
    "",
    "[providers.openai]",
    "enabled = true",
    'asr_model = "gpt-4o-transcribe"',
    'tts_model = "gpt-4o-mini-tts"',
    'tts_voice = "marin"',
    'tts_response_format = "wav"',
    'image_model = "gpt-image-1"',
    'image_size = "1024x1024"',
    "",
    "[providers.elevenlabs]",
    "enabled = true",
    'tts_model = "eleven_multilingual_v2"',
    'tts_voice_id = ""',
    'tts_output_format = "mp3_44100_128"',
    "",
    "[providers.google]",
    "enabled = true",
    'image_model = "imagen-4.0-generate-001"',
    'image_aspect_ratio = "1:1"',
    "",
    "[experimental]",
    "enable_shadow_window = false",
    "",
    "[realtime]",
    "enabled = true",
    'bridge_id = "local-smoke"',
    'public_url = ""',
    'control_url = ""',
    'surface_mode = "manual-arm"',
    'tunnel_mode = "managed-quick-cloudflared"',
    'tunnel_bin = "cloudflared"',
    'gateway_host = "127.0.0.1"',
    `gateway_port = ${gatewayPort}`,
    'model = "gpt-realtime"',
    'transcription_model = "gpt-4o-mini-transcribe"',
    'voice = "marin"',
    "startup_timeout_ms = 25000",
    "idle_warning_ms = 120000",
    "idle_timeout_ms = 600000",
    "auto_disarm_idle_ms = 300000",
    "launch_token_ttl_ms = 600000",
    "bootstrap_rate_limit_window_ms = 600000",
    "bootstrap_rate_limit_per_ip = 5",
    "bootstrap_rate_limit_per_bridge = 10",
    "bootstrap_rate_limit_per_user = 3",
    "max_call_ms = 120000",
    "max_daily_call_ms = 600000",
    'summary_model = "gpt-4.1-mini"',
    "",
  ].join("\n");

  await writeFile(tempEnvPath, `${tempEnvText}\n`, "utf8");
  await writeFile(tempConfigPath, tempConfigText, "utf8");

  const childEnv = {
    ...process.env,
    BRIDGE_CONFIG_PATH: tempConfigPath,
  };

  let gatewayChild = null;
  const cleanup = async () => {
    if (gatewayChild && !gatewayChild.killed) {
      gatewayChild.kill("SIGTERM");
      await new Promise(resolveDone => gatewayChild.once("exit", () => resolveDone()));
    }
    if (!keepTemp) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  };

  try {
    logSafe("Local smoke test");
    logSafe(`repoRoot=${repoRoot}`);
    logSafe(`workdir=${workdir}`);
    logSafe(`tempConfig=${keepTemp ? tempConfigPath : "(ephemeral temp dir)"}`);
    logSafe(`gatewayPort=${gatewayPort}`);
    logSafe(`appServerPort=${appServerPort}`);
    logSafe("");

    const capabilities = await execFileAsync(process.execPath, [DIST_BRIDGECTL, "capabilities"], {
      cwd: repoRoot,
      env: childEnv,
      encoding: "utf8",
    });
    logSafe("Capability summary");
    for (const line of capabilities.stdout.split(/\r?\n/)) {
      if (CAPABILITY_PREFIXES.some(prefix => line.startsWith(prefix))) {
        logSafe(line);
      }
    }
    logSafe("");

    const { TelegramClient } = await import(pathToFileURL(join(repoRoot, "dist", "core", "telegram", "client.js")).href);
    const client = new TelegramClient(selectedEnv.TELEGRAM_BOT_TOKEN, {
      debug() {},
      info() {},
      warn() {},
      error() {},
    });
    const me = await client.getMe();
    const webhook = await client.getWebhookInfo();
    logSafe("Telegram read-only probe");
    logJsonSafe({
      ok: true,
      botIdKnown: typeof me.id === "number",
      hasUsername: Boolean(me.username),
      webhookConfigured: Boolean(webhook.url),
    });
    logSafe("");

    if (skipGateway) {
      logSafe("Realtime gateway smoke");
      logSafe("skipped");
      return;
    }

    gatewayChild = spawn(process.execPath, [DIST_GATEWAY], {
      cwd: repoRoot,
      env: childEnv,
      stdio: "ignore",
    });
    const healthz = await waitForHealthz(`http://127.0.0.1:${gatewayPort}/healthz`);
    const detailsUnauth = await fetch(`http://127.0.0.1:${gatewayPort}/healthz/details`, {
      signal: AbortSignal.timeout(1_000),
    });
    const miniAppNoLaunch = await fetch(`http://127.0.0.1:${gatewayPort}/miniapp?bridgeId=local-smoke`, {
      signal: AbortSignal.timeout(1_000),
    });
    const bootstrapNoLaunch = await fetch(`http://127.0.0.1:${gatewayPort}/api/call/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bridgeId: "local-smoke", launch: "", initData: "" }),
      signal: AbortSignal.timeout(1_000),
    });

    const gatewaySummary = {
      healthzOk: Boolean(healthz?.ok),
      unauthenticatedDetailsStatus: detailsUnauth.status,
      miniAppWithoutLaunchStatus: miniAppNoLaunch.status,
      bootstrapWithoutLaunchStatus: bootstrapNoLaunch.status,
    };

    if (selectedEnv.REALTIME_CONTROL_SECRET) {
      const detailsAuth = await fetch(`http://127.0.0.1:${gatewayPort}/healthz/details`, {
        headers: { "x-bridge-secret": selectedEnv.REALTIME_CONTROL_SECRET },
        signal: AbortSignal.timeout(1_000),
      });
      const detailsAuthJson = await detailsAuth.json();
      gatewaySummary.authenticatedDetailsStatus = detailsAuth.status;
      gatewaySummary.bridgeCount = Array.isArray(detailsAuthJson.bridges) ? detailsAuthJson.bridges.length : null;
      gatewaySummary.callCount = Array.isArray(detailsAuthJson.calls) ? detailsAuthJson.calls.length : null;
    }

    logSafe("Realtime gateway smoke");
    logJsonSafe(gatewaySummary);
  } finally {
    await cleanup();
  }
}

main().catch(error => {
  console.error(redactSmokeValue(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
