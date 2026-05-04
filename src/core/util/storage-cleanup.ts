import { lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface StorageCleanupStats {
  scannedEntries: number;
  removedFiles: number;
  removedDirs: number;
  freedBytes: number;
}

const EMPTY_TIMEOUT_CALL_REASONS = new Set([
  "call_start_timeout",
  "call_launch_timeout",
]);
const DEFAULT_PERSISTENT_LOG_MAX_BYTES = 8 * 1024 * 1024;

export interface PersistentLogRotation {
  archivedPath: string;
  bytes: number;
}

function archiveStamp(timestampMs: number): string {
  return new Date(timestampMs).toISOString().replace(/[:.]/g, "-");
}

function emptyStats(): StorageCleanupStats {
  return {
    scannedEntries: 0,
    removedFiles: 0,
    removedDirs: 0,
    freedBytes: 0,
  };
}

function mergeStats(target: StorageCleanupStats, next: StorageCleanupStats): void {
  target.scannedEntries += next.scannedEntries;
  target.removedFiles += next.removedFiles;
  target.removedDirs += next.removedDirs;
  target.freedBytes += next.freedBytes;
}

async function cleanupEntry(path: string, cutoffMs: number, keepRoot: boolean, keepPaths: Set<string>): Promise<StorageCleanupStats> {
  const stats = emptyStats();
  const entry = await lstat(path).catch(() => null);
  if (!entry) {
    return stats;
  }

  stats.scannedEntries += 1;

  if (entry.isDirectory()) {
    const names = await readdir(path).catch(() => []);
    for (const name of names) {
      mergeStats(stats, await cleanupEntry(join(path, name), cutoffMs, false, keepPaths));
    }
    if (!keepRoot) {
      const remaining = await readdir(path).catch(() => []);
      if (remaining.length === 0 && entry.mtimeMs < cutoffMs) {
        await rm(path, { recursive: true, force: true });
        stats.removedDirs += 1;
      }
    }
    return stats;
  }

  if (keepPaths.has(path)) {
    return stats;
  }

  if (entry.mtimeMs < cutoffMs) {
    await rm(path, { force: true });
    stats.removedFiles += 1;
    stats.freedBytes += entry.size;
  }

  return stats;
}

async function measureEntryBytes(path: string): Promise<number> {
  const entry = await lstat(path).catch(() => null);
  if (!entry) {
    return 0;
  }
  if (!entry.isDirectory()) {
    return entry.size;
  }
  const names = await readdir(path).catch(() => []);
  let total = 0;
  for (const name of names) {
    total += await measureEntryBytes(join(path, name));
  }
  return total;
}

function transcriptHasContent(raw: string): boolean {
  return raw
    .split("\n")
    .map(line => line.trim())
    .some(line => Boolean(line)
      && !line.startsWith("# Call")
      && !line.startsWith("## User")
      && !line.startsWith("## Assistant"));
}

export async function cleanupEmptyTimeoutCallArtifacts(
  callsRoot: string,
  cutoffMs: number,
  options?: { preserveCallIds?: Iterable<string> },
): Promise<StorageCleanupStats> {
  const stats = emptyStats();
  const preserveCallIds = new Set(options?.preserveCallIds ?? []);
  const names = await readdir(callsRoot).catch(() => []);
  for (const name of names) {
    if (preserveCallIds.has(name)) {
      continue;
    }
    const callDir = join(callsRoot, name);
    const entry = await lstat(callDir).catch(() => null);
    if (!entry?.isDirectory()) {
      continue;
    }
    stats.scannedEntries += 1;
    if (entry.mtimeMs >= cutoffMs) {
      continue;
    }

    const statePath = join(callDir, "state.json");
    const transcriptPath = join(callDir, "transcript.md");
    const [stateRaw, transcriptRaw] = await Promise.all([
      readFile(statePath, "utf8").catch(() => null),
      readFile(transcriptPath, "utf8").catch(() => ""),
    ]);
    if (!stateRaw) {
      continue;
    }

    let state: { status?: string; endedReason?: string | null } | null = null;
    try {
      state = JSON.parse(stateRaw) as { status?: string; endedReason?: string | null };
    } catch {
      continue;
    }
    if (!state || state.status !== "ended" || !EMPTY_TIMEOUT_CALL_REASONS.has(state.endedReason ?? "")) {
      continue;
    }
    if (transcriptHasContent(transcriptRaw)) {
      continue;
    }

    const freedBytes = await measureEntryBytes(callDir);
    await rm(callDir, { recursive: true, force: true });
    stats.removedDirs += 1;
    stats.freedBytes += freedBytes;
  }
  return stats;
}

export async function rotatePersistentLogFile(
  path: string,
  options?: { maxBytes?: number; archiveRoot?: string; now?: number },
): Promise<PersistentLogRotation | null> {
  const maxBytes = options?.maxBytes ?? DEFAULT_PERSISTENT_LOG_MAX_BYTES;
  const entry = await lstat(path).catch(() => null);
  if (!entry || entry.isDirectory() || entry.size <= maxBytes) {
    return null;
  }

  const archiveRoot = options?.archiveRoot ?? join(dirname(path), "log-archive");
  const archiveDir = join(archiveRoot, archiveStamp(options?.now ?? Date.now()));
  await mkdir(archiveDir, { recursive: true });
  const archivedPath = join(archiveDir, basename(path));
  await rename(path, archivedPath);

  return {
    archivedPath,
    bytes: entry.size,
  };
}

export async function cleanupStorageRoots(
  roots: string[],
  cutoffMs: number,
  options?: { keepPaths?: Iterable<string> },
): Promise<StorageCleanupStats> {
  const stats = emptyStats();
  const keepPaths = new Set(options?.keepPaths ?? []);
  for (const root of roots) {
    mergeStats(stats, await cleanupEntry(root, cutoffMs, true, keepPaths));
  }
  return stats;
}
