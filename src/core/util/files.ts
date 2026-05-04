import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // Best-effort privacy on filesystems that support POSIX modes.
  }
  return path;
}

export function ensureParent(filePath: string): string {
  ensureDir(dirname(filePath));
  return filePath;
}

export function ensurePrivateFile(path: string): string {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort privacy on filesystems that support POSIX modes.
  }
  return path;
}

export function resolveWithin(root: string, ...parts: string[]): string {
  return resolve(root, ...parts);
}
