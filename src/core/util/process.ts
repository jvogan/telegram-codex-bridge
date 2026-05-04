import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

import { isProcessRunning } from "./pid.js";

const execFileAsync = promisify(execFile);
const PROCESS_PROBE_TIMEOUT_MS = 2_000;
const PROCESS_PROBE_MAX_BUFFER_BYTES = 1024 * 1024;

function isProcessProbeTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const timeoutError = error as { code?: unknown; killed?: unknown; message?: unknown };
  return timeoutError.code === "ETIMEDOUT"
    || timeoutError.killed === true
    || (typeof timeoutError.message === "string" && timeoutError.message.toLowerCase().includes("timed out"));
}

function isProcessProbeUnavailable(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const probeError = error as { code?: unknown; message?: unknown };
  return probeError.code === "EPERM"
    || probeError.code === "EACCES"
    || (typeof probeError.message === "string" && probeError.message.toLowerCase().includes("operation not permitted"));
}

async function execProcessProbe(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync(command, args, {
    timeout: PROCESS_PROBE_TIMEOUT_MS,
    maxBuffer: PROCESS_PROBE_MAX_BUFFER_BYTES,
  });
}

export interface ListeningProcess {
  pid: number;
  command: string;
}

export interface ListeningProcessDetails extends ListeningProcess {
  cwd: string | null;
}

export interface RunningProcess {
  pid: number;
  command: string;
}

export function parsePsProcessList(stdout: string): RunningProcess[] {
  const processes: RunningProcess[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const match = trimmed.match(/^(\d+)\s+(.*)$/);
    if (!match) {
      continue;
    }
    const pid = Number.parseInt(match[1] ?? "", 10);
    const command = match[2] ?? "";
    if (!Number.isFinite(pid)) {
      continue;
    }
    processes.push({ pid, command });
  }
  return processes;
}

export function parseLsofCwd(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("n")) {
      return line.slice(1) || null;
    }
  }
  return null;
}

export async function findListeningProcess(port: number): Promise<ListeningProcess | null> {
  try {
    const { stdout } = await execProcessProbe("lsof", [
      "-nP",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-Fpc",
    ]);
    let pid: number | null = null;
    let command = "";
    for (const line of stdout.split(/\r?\n/)) {
      if (line.startsWith("p")) {
        const parsed = Number.parseInt(line.slice(1), 10);
        if (Number.isFinite(parsed)) {
          pid = parsed;
        }
      } else if (line.startsWith("c")) {
        command = line.slice(1);
      }
      if (pid && command) {
        return { pid, command };
      }
    }
    return null;
  } catch (error) {
    if (isProcessProbeTimeout(error) || isProcessProbeUnavailable(error)) {
      return null;
    }
    const code = (error as { code?: number }).code;
    if (code === 1) {
      return null;
    }
    throw error;
  }
}

export async function inspectListeningProcess(port: number): Promise<ListeningProcessDetails | null> {
  const listener = await findListeningProcess(port);
  if (!listener) {
    return null;
  }
  return {
    ...listener,
    cwd: await getProcessWorkingDirectory(listener.pid),
  };
}

export async function killProcessGracefully(pid: number, timeoutMs = 10_000): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return;
    }
    await sleep(250);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
  const killDeadline = Date.now() + 5_000;
  while (Date.now() < killDeadline) {
    if (!isProcessRunning(pid)) {
      return;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for process ${pid} to exit.`);
}

export async function cleanupStaleCodexAppServer(
  port: number,
  options?: { cwd?: string },
): Promise<ListeningProcess | null> {
  const listener = await findListeningProcess(port);
  if (!listener) {
    return null;
  }
  if (!listener.command.toLowerCase().includes("codex")) {
    throw new Error(`Port ${port} is in use by ${listener.command} (pid ${listener.pid}).`);
  }
  const expectedCwd = options?.cwd ? resolve(options.cwd) : null;
  if (expectedCwd) {
    const cwd = await getProcessWorkingDirectory(listener.pid);
    if (!cwd || resolve(cwd) !== expectedCwd) {
      throw new Error(`Port ${port} is in use by ${listener.command} (pid ${listener.pid}) from ${cwd ?? "unknown cwd"}.`);
    }
  }
  await killProcessGracefully(listener.pid);
  return listener;
}

export async function findRunningProcessByPattern(
  pattern: RegExp,
  options?: { excludePid?: number; cwd?: string },
): Promise<RunningProcess | null> {
  let stdout = "";
  try {
    ({ stdout } = await execProcessProbe("ps", ["-axo", "pid=,command="]));
  } catch (error) {
    if (isProcessProbeTimeout(error) || isProcessProbeUnavailable(error)) {
      return null;
    }
    throw error;
  }
  const expectedCwd = options?.cwd ? resolve(options.cwd) : null;
  for (const { pid, command } of parsePsProcessList(stdout)) {
    if (options?.excludePid && pid === options.excludePid) {
      continue;
    }
    if (processCommandMatchesPattern(command, pattern)) {
      if (expectedCwd) {
        const cwd = await getProcessWorkingDirectory(pid);
        if (!cwd || resolve(cwd) !== expectedCwd) {
          continue;
        }
      }
      return { pid, command };
    }
  }
  return null;
}

export async function getRunningProcess(pid: number): Promise<RunningProcess | null> {
  if (!isProcessRunning(pid)) {
    return null;
  }
  try {
    const { stdout } = await execProcessProbe("ps", ["-p", String(pid), "-o", "pid=,command="]);
    return parsePsProcessList(stdout)[0] ?? null;
  } catch (error) {
    if (isProcessProbeTimeout(error) || isProcessProbeUnavailable(error)) {
      return null;
    }
    const code = (error as { code?: number }).code;
    if (code === 1) {
      return null;
    }
    throw error;
  }
}

export function processCommandMatchesPattern(command: string, pattern: RegExp): boolean {
  pattern.lastIndex = 0;
  return pattern.test(command);
}

export async function getMatchingRunningProcess(
  pid: number,
  pattern: RegExp,
  options?: { cwd?: string },
): Promise<RunningProcess | null> {
  const processInfo = await getRunningProcess(pid);
  if (!processInfo || !processCommandMatchesPattern(processInfo.command, pattern)) {
    return null;
  }
  const expectedCwd = options?.cwd ? resolve(options.cwd) : null;
  if (expectedCwd) {
    const cwd = await getProcessWorkingDirectory(pid);
    if (!cwd || resolve(cwd) !== expectedCwd) {
      return null;
    }
  }
  return processInfo;
}

export async function getProcessWorkingDirectory(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execProcessProbe("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    return parseLsofCwd(stdout);
  } catch (error) {
    if (isProcessProbeTimeout(error) || isProcessProbeUnavailable(error)) {
      return null;
    }
    const code = (error as { code?: number }).code;
    if (code === 1) {
      return null;
    }
    throw error;
  }
}
