import { describe, expect, test } from "vitest";

import {
  authorizedChatIdHintMessage,
  missingOpenAIForRealtimeMessage,
  missingOpenAIProviderMessage,
  missingRealtimeControlSecretMessage,
  missingTelegramBotTokenForCallInviteMessage,
  missingTelegramBotTokenMessage,
  noMatchingDesktopThreadsMessage,
  noPendingPrivateChatUpdatesLines,
} from "../src/core/onboarding-messages.js";

describe("onboarding messages", () => {
  test("guides the user when private chat discovery has no updates yet", () => {
    expect(noPendingPrivateChatUpdatesLines()).toEqual([
      "No pending private-chat updates were found.",
      "Send /start to the bot from Telegram using the account you want to authorize, then run `npm run telegram:discover` again.",
    ]);
    expect(authorizedChatIdHintMessage()).toBe(
      "Copy the matching chat ID into telegram.authorized_chat_id in bridge.config.toml.",
    );
  });

  test("guides the user when a desktop thread is missing", () => {
    expect(noMatchingDesktopThreadsMessage()).toBe(
      "No matching desktop Codex threads. Open the target workspace in Codex Desktop first, then rerun `npm run bridge:claim` from that session.",
    );
  });

  test("guides the user toward the right env vars for onboarding and live calling", () => {
    expect(missingTelegramBotTokenMessage()).toBe(
      "TELEGRAM_BOT_TOKEN is required. Copy .env.example to .env and set TELEGRAM_BOT_TOKEN before running bridge commands.",
    );
    expect(missingTelegramBotTokenForCallInviteMessage()).toBe(
      "TELEGRAM_BOT_TOKEN is required to send a call invite. Add it to .env before using `bridgectl call invite`.",
    );
    expect(missingOpenAIForRealtimeMessage()).toBe(
      "OPENAI_API_KEY is required for realtime calling. Add it to .env before starting realtime-gateway or using /call.",
    );
    expect(missingOpenAIProviderMessage()).toBe(
      "OPENAI_API_KEY is required for the OpenAI provider. Add it to .env to enable OpenAI-backed ASR, TTS, image generation, or /call.",
    );
    expect(missingRealtimeControlSecretMessage()).toBe(
      "REALTIME_CONTROL_SECRET is required to hang up a live call from bridgectl. Add it to .env when enabling /call.",
    );
  });
});
