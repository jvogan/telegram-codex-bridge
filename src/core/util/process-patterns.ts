export const TELEGRAM_DAEMON_PROCESS_PATTERN =
  /(?:^|\s)(?:bridge-telegram-daemon|telegram-codex-bridge-daemon|(?:node|bun)\s+.*telegram-daemon\.js)(?:\s|$)/;

export const REALTIME_GATEWAY_PROCESS_PATTERN =
  /(?:^|\s)(?:bridge-realtime-gateway|telegram-codex-bridge-realtime-gateway|(?:node|bun)\s+.*realtime-gateway\.js)(?:\s|$)/;

export function isManagedTelegramDaemonProcess(command: string): boolean {
  return TELEGRAM_DAEMON_PROCESS_PATTERN.test(command);
}

export function isManagedRealtimeGatewayProcess(command: string): boolean {
  return REALTIME_GATEWAY_PROCESS_PATTERN.test(command);
}
