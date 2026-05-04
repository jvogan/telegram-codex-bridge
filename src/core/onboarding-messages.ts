export function missingBridgeConfigMessage(configPath: string): string {
  return `Bridge config not found at ${configPath}. Copy bridge.config.example.toml to bridge.config.toml first.`;
}

export function missingCodexBinaryMessage(): string {
  return "Codex Desktop could not be found automatically. Set bridge.codex_binary in bridge.config.toml, or set CODEX_BINARY, or make `codex` available on PATH before starting the bridge daemon.";
}

export function missingTelegramBotTokenMessage(): string {
  return "TELEGRAM_BOT_TOKEN is required. Copy .env.example to .env and set TELEGRAM_BOT_TOKEN before running bridge commands.";
}

export function missingTelegramBotTokenForCallInviteMessage(): string {
  return "TELEGRAM_BOT_TOKEN is required to send a call invite. Add it to .env before using `bridgectl call invite`.";
}

export function missingOpenAIForRealtimeMessage(): string {
  return "OPENAI_API_KEY is required for realtime calling. Add it to .env before starting realtime-gateway or using /call.";
}

export function missingOpenAIProviderMessage(): string {
  return "OPENAI_API_KEY is required for the OpenAI provider. Add it to .env to enable OpenAI-backed ASR, TTS, image generation, or /call.";
}

export function missingRealtimeControlSecretMessage(): string {
  return "REALTIME_CONTROL_SECRET is required to hang up a live call from bridgectl. Add it to .env when enabling /call.";
}

export function noPendingPrivateChatUpdatesLines(): string[] {
  return [
    "No pending private-chat updates were found.",
    "Send /start to the bot from Telegram using the account you want to authorize, then run `npm run telegram:discover` again.",
  ];
}

export function authorizedChatIdHintMessage(): string {
  return "Copy the matching chat ID into telegram.authorized_chat_id in bridge.config.toml.";
}

export function noMatchingDesktopThreadsMessage(): string {
  return "No matching desktop Codex threads. Open the target workspace in Codex Desktop first, then rerun `npm run bridge:claim` from that session.";
}
