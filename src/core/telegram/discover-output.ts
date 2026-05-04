export interface DiscoveredPrivateChat {
  chatId: string;
  username?: string;
  firstName?: string;
  lastName?: string;
}

function formatPrivateChatLabel(chat: DiscoveredPrivateChat): string | null {
  if (chat.username) {
    return `@${chat.username}`;
  }
  const name = [chat.firstName, chat.lastName].filter(Boolean).join(" ").trim();
  return name || null;
}

export function formatWebhookStatusLine(
  webhookUrl: string | null | undefined,
  options: { verbose?: boolean } = {},
): string {
  if (!webhookUrl) {
    return "Webhook configured: none";
  }
  if (!options.verbose) {
    return "Webhook configured: yes (url redacted)";
  }
  try {
    const url = new URL(webhookUrl);
    return `Webhook configured: ${url.protocol}//${url.host}/[redacted]`;
  } catch {
    return "Webhook configured: [redacted]";
  }
}

export function formatDiscoveredPrivateChatLine(
  chat: DiscoveredPrivateChat,
  options: { verbose?: boolean } = {},
): string {
  if (!options.verbose) {
    return `- ${chat.chatId}`;
  }
  const label = formatPrivateChatLabel(chat);
  return label ? `- ${chat.chatId} ${label}` : `- ${chat.chatId}`;
}
