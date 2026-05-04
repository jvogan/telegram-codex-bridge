import "dotenv/config";

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createLogger } from "../core/logger.js";
import { loadBridgeEnv, loadConfig, requireTelegramBotToken } from "../core/config.js";
import { TelegramClient } from "../core/telegram/client.js";

const entryDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(entryDir, "../..");
process.env.BRIDGE_CONFIG_PATH ??= join(repoRoot, "bridge.config.toml");

const logger = createLogger("telegram-configure");
const BOT_COMMANDS = [
  { command: "start", description: "Show the bot welcome message" },
  { command: "help", description: "List available commands" },
  { command: "status", description: "Show bridge, queue, and thread status" },
  { command: "capabilities", description: "Show what this Telegram-bound session can do right now" },
  { command: "where", description: "Show current mode, binding, and routing state" },
  { command: "threads", description: "List recent desktop Codex threads to bind" },
  { command: "inbox", description: "Show queued Telegram tasks and pending approvals" },
  { command: "mode", description: "Show or switch bridge execution mode" },
  { command: "attach_current", description: "Bind to the current desktop Codex thread" },
  { command: "attach", description: "Bind to a specific desktop Codex thread id" },
  { command: "teleport", description: "Verify and switch to a desktop Codex thread" },
  { command: "detach", description: "Clear the current desktop thread binding" },
  { command: "owner", description: "Set whether Telegram or desktop owns the session" },
  { command: "sleep", description: "Pause Telegram processing without losing queued messages" },
  { command: "wake", description: "Resume Telegram processing" },
  { command: "providers", description: "Show active ASR, TTS, and image providers" },
  { command: "call", description: "Launch or inspect the live call Mini App" },
  { command: "hangup", description: "End the active live call" },
  { command: "fallback", description: "Inspect or control the safe fallback Codex lane" },
  { command: "terminal", description: "Inspect or use the gated terminal Codex lane" },
  { command: "image", description: "Generate and send an image to this chat" },
  { command: "speak", description: "Make the next reply include generated audio" },
  { command: "interrupt", description: "Interrupt the current Codex turn" },
  { command: "reset", description: "Start a fresh persistent Codex thread when supported" },
  { command: "provider", description: "Switch ASR, TTS, or image provider overrides" },
  { command: "shutdown", description: "Stop the local Telegram bridge daemon" },
];

async function main(): Promise<void> {
  const config = loadConfig();
  const env = loadBridgeEnv(config);
  const token = requireTelegramBotToken(env);
  const botDescription = [
    `${config.branding.bot_name} is a ${config.branding.bot_description.replace(/\.$/, "")}.`,
    "Send text, files, photos, or voice notes for repo work, coding help, and local tool execution.",
    "Generated images and audio can come back through normal Codex requests.",
  ].join(" ");
  const telegram = new TelegramClient(token, logger);

  await telegram.setMyName(config.branding.bot_name);
  await telegram.setMyDescription(botDescription);
  await telegram.setMyShortDescription(config.branding.bot_short_description);
  await telegram.setMyCommands(BOT_COMMANDS);

  const me = await telegram.getMe();
  console.log(`Configured @${me.username ?? "(no username)"} as ${config.branding.bot_name}.`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
