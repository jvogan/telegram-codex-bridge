import "dotenv/config";

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createLogger } from "../core/logger.js";
import { loadBridgeEnv, loadConfig, requireTelegramBotToken } from "../core/config.js";
import { authorizedChatIdHintMessage, noPendingPrivateChatUpdatesLines } from "../core/onboarding-messages.js";
import { TelegramClient } from "../core/telegram/client.js";
import { formatDiscoveredPrivateChatLine, formatWebhookStatusLine } from "../core/telegram/discover-output.js";

const entryDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(entryDir, "../..");
process.env.BRIDGE_CONFIG_PATH ??= join(repoRoot, "bridge.config.toml");

const logger = createLogger("telegram-discover");

async function main(): Promise<void> {
  const shouldClearWebhook = process.argv.includes("--clear-webhook");
  const verbose = process.argv.includes("--verbose");
  const config = loadConfig();
  const token = requireTelegramBotToken(loadBridgeEnv(config));
  const telegram = new TelegramClient(token, logger);
  const me = await telegram.getMe();
  const webhook = await telegram.getWebhookInfo();

  console.log(`Bot: @${me.username ?? "(no username)"} (${me.id})`);
  console.log(`Name: ${me.first_name ?? ""}${me.last_name ? ` ${me.last_name}` : ""}`.trim());
  if (webhook.url) {
    console.log(formatWebhookStatusLine(webhook.url, { verbose }));
    if (!shouldClearWebhook) {
      console.log("Long polling will not work until the webhook is removed.");
      console.log("Re-run this command with `--clear-webhook` to clear it explicitly.");
      if (!verbose) {
        console.log("Use `--verbose` if you also want redacted webhook-host detail or private-chat labels.");
      }
      return;
    }
    await telegram.deleteWebhook(false);
    console.log("Webhook cleared.");
  }
  console.log(formatWebhookStatusLine(null));

  const updates = await telegram.getUpdates(0, 1, 25);

  const privateChats = new Map<string, { username?: string; firstName?: string; lastName?: string }>();
  for (const update of updates) {
    const message = update.message;
    if (!message || message.chat.type !== "private") {
      continue;
    }
    const chatId = String(message.chat.id);
    privateChats.set(chatId, {
      ...(message.from?.username ? { username: message.from.username } : {}),
      ...(message.from?.first_name ? { firstName: message.from.first_name } : {}),
      ...(message.from?.last_name ? { lastName: message.from.last_name } : {}),
    });
  }

  if (privateChats.size === 0) {
    console.log("");
    for (const line of noPendingPrivateChatUpdatesLines()) {
      console.log(line);
    }
    return;
  }

  console.log("");
  console.log("Private chats seen in pending updates:");
  for (const [chatId, info] of privateChats) {
    console.log(formatDiscoveredPrivateChatLine({
      chatId,
      ...info,
    }, { verbose }));
  }
  console.log("");
  console.log(authorizedChatIdHintMessage());
  if (!verbose) {
    console.log("Re-run with `--verbose` if you need redacted webhook-host detail or private-chat labels during setup.");
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
