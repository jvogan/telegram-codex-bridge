import { posix, win32 } from "node:path";

interface DisplayPathOptions {
  demoPracticeMode?: boolean | undefined;
  emptyLabel?: string | undefined;
}

function basenameForAnyPlatform(pathValue: string): string {
  if (win32.isAbsolute(pathValue)) {
    return win32.basename(pathValue);
  }
  if (posix.isAbsolute(pathValue)) {
    return posix.basename(pathValue);
  }
  return pathValue;
}

export function formatDisplayPath(
  pathValue: string | null | undefined,
  options: DisplayPathOptions = {},
): string {
  const emptyLabel = options.emptyLabel ?? "none";
  if (pathValue === null || pathValue === undefined) {
    return emptyLabel;
  }

  const trimmed = pathValue.trim();
  if (!trimmed) {
    return emptyLabel;
  }

  if (!options.demoPracticeMode) {
    return trimmed;
  }

  if (!posix.isAbsolute(trimmed) && !win32.isAbsolute(trimmed)) {
    return trimmed;
  }

  return basenameForAnyPlatform(trimmed) || "[redacted path]";
}
