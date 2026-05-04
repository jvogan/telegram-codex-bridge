import { basename } from "node:path";

const FILE_EXTENSION_PATTERN = [
  "png",
  "jpe?g",
  "gif",
  "webp",
  "svg",
  "pdf",
  "txt",
  "md",
  "csv",
  "tsv",
  "json",
  "mp3",
  "wav",
  "ogg",
  "m4a",
  "mp4",
  "mov",
  "webm",
].join("|");

const FILE_PATH_PATTERN = new RegExp(
  String.raw`(^|[\s([{"'\`])((?:(?:/|\.{1,2}/|[A-Za-z0-9._-]+/)[A-Za-z0-9._/-]*[A-Za-z0-9._-]+\.`
    + String.raw`(?:${FILE_EXTENSION_PATTERN})))(?=$|[\s)\]}"'\`.,;:!?])`,
  "gi",
);

const ABSOLUTE_PATH_PATTERN = /(^|[\s([{"'`])((?:\/(?!\/)[^\s)\]}"'`,;:!?]+){2,})(?=$|[\s)\]}"'`,;:!?])/g;
const TELEGRAM_FILE_ID_PATTERN = /\b(file_id|file_unique_id)\s*[:=]\s*[A-Za-z0-9_-]{12,}/gi;
const BRIDGE_INTERNAL_ID_PATTERN = /\b(thread|turn|task|call|launchToken|launch_token|token)Id\s*[:=]\s*[0-9a-f]{8,}(?:-[0-9a-f]{4,}){0,4}\b/gi;

function publicSafeFileLabel(pathValue: string): string {
  const shortName = basename(pathValue);
  return shortName && shortName.includes(".") ? shortName : "[local path]";
}

function redactPublicTelegramText(text: string): string {
  return text
    .replace(TELEGRAM_FILE_ID_PATTERN, "$1=[redacted]")
    .replace(BRIDGE_INTERNAL_ID_PATTERN, "$1Id=[redacted]")
    .replace(ABSOLUTE_PATH_PATTERN, (_match, prefix: string, pathValue: string) => {
      return `${prefix}${publicSafeFileLabel(pathValue)}`;
    })
    .replace(FILE_PATH_PATTERN, (_match, prefix: string, pathValue: string) => {
      const shortName = basename(pathValue);
      return `${prefix}${shortName || "[redacted file]"}`;
    });
}

export function sanitizeTelegramFinalText(text: string): string {
  return redactPublicTelegramText(
    text
      .split(/\r?\n/)
      .filter(line => {
        const normalized = line.trim().toLowerCase();
        return !(
          normalized.includes("bridge context note")
          || normalized.includes("bridge note")
          || normalized.includes("not from the user")
          || normalized.includes("answer as a telegram chat reply")
          || normalized.includes("operational commentary")
          || normalized.includes("voice reply automatically")
          || normalized.includes("image-generation tool")
          || normalized.includes("active paper title:")
          || normalized.includes("prefer local paper context")
          || normalized.includes("use the web only if")
          || normalized.includes("do not reveal")
          || normalized.includes("staged local copy")
          || normalized.includes("internal paths")
          || normalized.includes("bridge implementation")
        );
      })
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}
