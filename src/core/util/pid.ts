import { readFile, rm, writeFile } from "node:fs/promises";

export async function writePidFile(path: string, pid = process.pid): Promise<void> {
  await writeFile(path, `${pid}\n`, "utf8");
}

export async function removePidFile(path: string, ownerPid?: number): Promise<void> {
  if (ownerPid === undefined) {
    await rm(path, { force: true });
    return;
  }
  const currentPid = await readPidFile(path);
  if (currentPid !== ownerPid) {
    return;
  }
  await rm(path, { force: true });
}

export async function readPidFile(path: string): Promise<number | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
