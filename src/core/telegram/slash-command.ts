export interface ParsedTelegramSlashCommand {
  command: string;
  args: string[];
}

export function normalizeTelegramSlashCommandName(rawCommand: string): string | null {
  const trimmed = rawCommand.trim();
  if (!trimmed.startsWith("/") || trimmed === "/") {
    return null;
  }
  const mentionIndex = trimmed.indexOf("@");
  const command = (mentionIndex > 1 ? trimmed.slice(0, mentionIndex) : trimmed).toLowerCase();
  return command.length > 1 ? command : null;
}

export function parseTelegramSlashCommand(text: string): ParsedTelegramSlashCommand | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const [rawCommand, ...args] = trimmed.trim().split(/\s+/);
  const command = normalizeTelegramSlashCommandName(rawCommand ?? "");
  return command ? { command, args } : null;
}
