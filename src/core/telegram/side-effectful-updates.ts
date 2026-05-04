import { normalizeTelegramSlashCommandName } from "./slash-command.js";

const SIDE_EFFECTFUL_SLASH_COMMANDS = new Set([
  "/mode",
  "/attach-current",
  "/attach_current",
  "/attach",
  "/teleport",
  "/detach",
  "/owner",
  "/sleep",
  "/wake",
  "/interrupt",
  "/reset",
  "/image",
  "/speak",
  "/provider",
  "/shutdown",
  "/hangup",
]);

export function sideEffectfulSlashCommandCategory(command: string, args: string[]): string | null {
  const normalizedCommand = normalizeTelegramSlashCommandName(command);
  if (!normalizedCommand) {
    return null;
  }
  if (normalizedCommand === "/call") {
    return args[0]?.toLowerCase() === "status" ? null : "command:/call";
  }
  if (normalizedCommand === "/terminal") {
    const action = args[0]?.toLowerCase() ?? "status";
    return ["status"].includes(action) ? null : "command:/terminal";
  }
  if (normalizedCommand === "/fallback") {
    const action = args[0]?.toLowerCase() ?? "status";
    return ["status"].includes(action) ? null : "command:/fallback";
  }
  return SIDE_EFFECTFUL_SLASH_COMMANDS.has(normalizedCommand) ? `command:${normalizedCommand}` : null;
}
