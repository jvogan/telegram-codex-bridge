import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const DEFAULT_SESSION_NAME = "telegram-codex-bridge-terminal";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_ASK_TIMEOUT_MS = 10 * 60_000;
const SAFE_TMUX_CODEX_COMMAND_RE = /^[A-Za-z0-9_@%+=:,./-]+$/;
const TMUX_OWNER_OPTION = "@telegram-codex-bridge-owner-nonce";
const TMUX_LAUNCH_HASH_OPTION = "@telegram-codex-bridge-launch-args-hash";
const TERMINAL_LANE_OK_PREFIX = "BRIDGE_TERMINAL_LANE_OK_";
const TERMINAL_DONE_PREFIX = "BRIDGE_TERMINAL_DONE_";

export interface TmuxCodexQuery {
  sessionName?: string;
  expectedDirectoryHint?: string;
  expectedPaneId?: string | null;
}

export interface TmuxCodexSession {
  paneId: string;
  tty: string;
  name: string;
  cwd: string | null;
  contents: string;
}

export interface TmuxCodexStatus {
  found: boolean;
  ready: boolean;
  session: TmuxCodexSession | null;
  blocker: string | null;
}

export interface TmuxCodexAskStart {
  marker: string;
  session: TmuxCodexSession;
  submittedPrompt: string;
  contentsBefore: string;
  startedAt: number;
}

export interface TmuxCodexAskResult {
  marker: string;
  session: TmuxCodexSession;
  observed: boolean;
  elapsedMs: number;
  answerText: string | null;
}

export interface TmuxCodexExec {
  execFile(command: string, args: string[], options?: { timeout?: number; maxBuffer?: number; cwd?: string }): Promise<{ stdout: string; stderr: string }>;
}

const defaultRunner: TmuxCodexExec = {
  async execFile(command, args, options) {
    const { stdout, stderr } = await execFile(command, args, {
      ...options,
      encoding: "utf8",
    });
    return {
      stdout: String(stdout),
      stderr: String(stderr),
    };
  },
};

function normalizeTty(value: string): string {
  return value.startsWith("/dev/") ? value : `/dev/${value}`;
}

function ttyName(value: string): string {
  return normalizeTty(value).replace(/^\/dev\//, "");
}

async function tmux(args: string[], runner: TmuxCodexExec = defaultRunner): Promise<string> {
  const { stdout } = await runner.execFile("tmux", args, {
    timeout: 10_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trimEnd();
}

function assertSafeTmuxCodexCommand(command: string): void {
  if (!SAFE_TMUX_CODEX_COMMAND_RE.test(command)) {
    throw new Error("tmux Codex command must be a single executable path without whitespace or shell metacharacters.");
  }
}

async function capturePane(paneId: string, runner: TmuxCodexExec = defaultRunner): Promise<string> {
  return await tmux(["capture-pane", "-p", "-t", paneId, "-S", "-2000"], runner);
}

async function submitTmuxText(paneId: string, text: string, runner: TmuxCodexExec = defaultRunner): Promise<void> {
  await tmux(["send-keys", "-t", paneId, "--", text], runner);
  await new Promise(resolve => setTimeout(resolve, 100));
  await tmux(["send-keys", "-t", paneId, "Enter"], runner);
}

async function ttyHasCodexProcess(tty: string, runner: TmuxCodexExec = defaultRunner): Promise<boolean> {
  const { stdout } = await runner.execFile("ps", ["-axo", "tty=,command="], {
    timeout: 5_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const target = ttyName(tty);
  return stdout.split("\n").some(line => {
    const trimmed = line.trimStart();
    return trimmed.startsWith(`${target} `) && /\bcodex(?:\s|$)/.test(trimmed);
  });
}

function parsePaneList(output: string): Array<Omit<TmuxCodexSession, "contents">> {
  return output.split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [name = "", paneId = "", tty = "", cwd = ""] = line.split("\t");
      return {
        name,
        paneId,
        tty: normalizeTty(tty),
        cwd: cwd || null,
      };
    })
    .filter(entry => entry.name && entry.paneId && entry.tty);
}

export function isTmuxCodexSessionReady(session: TmuxCodexSession): { ready: boolean; blocker: string | null } {
  if (!session.contents.includes("OpenAI Codex")) {
    return { ready: false, blocker: "session is not showing Codex CLI" };
  }
  if (session.contents.includes("esc to interrupt")) {
    return { ready: false, blocker: "Codex CLI appears to be busy" };
  }
  if (!session.contents.includes("›")) {
    return { ready: false, blocker: "Codex CLI prompt is not visible" };
  }
  return { ready: true, blocker: null };
}

export async function findTmuxCodexSession(
  query: TmuxCodexQuery,
  runner: TmuxCodexExec = defaultRunner,
): Promise<{ session: TmuxCodexSession | null; ambiguous: boolean }> {
  const sessionName = query.sessionName ?? DEFAULT_SESSION_NAME;
  const expectedDirectoryHint = query.expectedDirectoryHint ?? "";
  const expectedPaneId = query.expectedPaneId ?? null;
  let paneRows = "";
  try {
    paneRows = await tmux(["list-panes", "-a", "-F", "#{session_name}\t#{pane_id}\t#{pane_tty}\t#{pane_current_path}"], runner);
  } catch {
    return { session: null, ambiguous: false };
  }
  const matches: TmuxCodexSession[] = [];
  for (const pane of parsePaneList(paneRows)) {
    if (pane.name !== sessionName) {
      continue;
    }
    if (expectedPaneId && pane.paneId !== expectedPaneId) {
      continue;
    }
    if (expectedDirectoryHint && pane.cwd && !pane.cwd.includes(expectedDirectoryHint)) {
      continue;
    }
    const contents = await capturePane(pane.paneId, runner);
    if (!contents.includes("OpenAI Codex")) {
      continue;
    }
    if (expectedDirectoryHint && !contents.includes(expectedDirectoryHint) && !pane.cwd?.includes(expectedDirectoryHint)) {
      continue;
    }
    matches.push({ ...pane, contents });
  }
  if (matches.length > 1) {
    return { session: null, ambiguous: true };
  }
  return { session: matches[0] ?? null, ambiguous: false };
}

export async function getTmuxCodexStatus(
  query: TmuxCodexQuery,
  runner: TmuxCodexExec = defaultRunner,
): Promise<TmuxCodexStatus> {
  const found = await findTmuxCodexSession(query, runner);
  if (found.ambiguous) {
    return {
      found: false,
      ready: false,
      session: null,
      blocker: "Multiple matching tmux Codex CLI panes were found; lock a specific pane before sending work.",
    };
  }
  const session = found.session;
  if (!session) {
    return {
      found: false,
      ready: false,
      session: null,
      blocker: "No matching tmux Codex CLI session was found.",
    };
  }
  if (!await ttyHasCodexProcess(session.tty, runner)) {
    return {
      found: true,
      ready: false,
      session,
      blocker: `No Codex CLI process is attached to ${session.tty}.`,
    };
  }
  const readiness = isTmuxCodexSessionReady(session);
  return {
    found: true,
    ready: readiness.ready,
    session,
    blocker: readiness.blocker,
  };
}

export async function tmuxSessionExists(
  sessionName = DEFAULT_SESSION_NAME,
  runner: TmuxCodexExec = defaultRunner,
): Promise<boolean> {
  try {
    await tmux(["has-session", "-t", sessionName], runner);
    return true;
  } catch {
    return false;
  }
}

export async function startTmuxCodexSession(
  options: {
    sessionName?: string;
    cwd: string;
    codexCommand?: string;
    shellCommand?: string;
  },
  runner: TmuxCodexExec = defaultRunner,
): Promise<void> {
  const sessionName = options.sessionName ?? DEFAULT_SESSION_NAME;
  const shellCommand = options.shellCommand;
  if (shellCommand) {
    await tmux(["new-session", "-d", "-s", sessionName, "-c", options.cwd, shellCommand], runner);
    return;
  }
  const codexCommand = options.codexCommand ?? "codex";
  assertSafeTmuxCodexCommand(codexCommand);
  await tmux(["new-session", "-d", "-s", sessionName, "-c", options.cwd, codexCommand], runner);
}

export async function setTmuxCodexOwner(
  sessionName: string,
  ownerNonce: string,
  launchArgsHash: string,
  runner: TmuxCodexExec = defaultRunner,
): Promise<void> {
  await tmux(["set-option", "-t", sessionName, TMUX_OWNER_OPTION, ownerNonce], runner);
  await tmux(["set-option", "-t", sessionName, TMUX_LAUNCH_HASH_OPTION, launchArgsHash], runner);
}

export async function getTmuxSessionOption(
  sessionName: string,
  optionName: string,
  runner: TmuxCodexExec = defaultRunner,
): Promise<string | null> {
  try {
    const value = await tmux(["show-options", "-v", "-t", sessionName, optionName], runner);
    return value.trim() || null;
  } catch {
    return null;
  }
}

export async function getTmuxCodexOwnerNonce(
  sessionName: string,
  runner: TmuxCodexExec = defaultRunner,
): Promise<string | null> {
  return await getTmuxSessionOption(sessionName, TMUX_OWNER_OPTION, runner);
}

export async function stopTmuxCodexSession(
  sessionName = DEFAULT_SESSION_NAME,
  options: { ownerNonce?: string | null } = {},
  runner: TmuxCodexExec = defaultRunner,
): Promise<void> {
  if (options.ownerNonce) {
    const actualOwnerNonce = await getTmuxCodexOwnerNonce(sessionName, runner);
    if (actualOwnerNonce !== options.ownerNonce) {
      throw new Error("Refusing to stop tmux session because the bridge owner nonce does not match.");
    }
  }
  await tmux(["kill-session", "-t", sessionName], runner);
}

export async function sendTmuxCodexPrompt(
  prompt: string,
  query: TmuxCodexQuery,
  runner: TmuxCodexExec = defaultRunner,
): Promise<TmuxCodexSession> {
  const status = await getTmuxCodexStatus(query, runner);
  if (!status.session) {
    throw new Error(status.blocker ?? "No matching tmux Codex CLI session was found.");
  }
  if (!status.ready) {
    throw new Error(status.blocker ?? "Codex CLI session is not ready.");
  }
  await submitTmuxText(status.session.paneId, prompt, runner);
  return status.session;
}

export async function sendTmuxCodexControl(
  control: "interrupt" | "clear",
  query: TmuxCodexQuery,
  runner: TmuxCodexExec = defaultRunner,
): Promise<TmuxCodexSession> {
  const status = await getTmuxCodexStatus(query, runner);
  if (!status.session) {
    throw new Error(status.blocker ?? "No matching tmux Codex CLI session was found.");
  }
  if (control === "clear" && !status.ready) {
    throw new Error(status.blocker ?? "Codex CLI session is not ready.");
  }
  if (control === "interrupt") {
    await tmux(["send-keys", "-t", status.session.paneId, "C-c"], runner);
  } else {
    await submitTmuxText(status.session.paneId, "/clear", runner);
  }
  return status.session;
}

export async function readTmuxCodexSessionByPaneId(
  paneId: string,
  query: TmuxCodexQuery,
  runner: TmuxCodexExec = defaultRunner,
): Promise<TmuxCodexSession | null> {
  const found = await findTmuxCodexSession({ ...query, expectedPaneId: paneId }, runner);
  return found.session;
}

export async function pingTmuxCodex(
  query: TmuxCodexQuery,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
  runner: TmuxCodexExec = defaultRunner,
) {
  const marker = `${TERMINAL_LANE_OK_PREFIX}${Date.now()}`;
  const startedAt = Date.now();
  const session = await sendTmuxCodexPrompt(
    `Reply with exactly this single line and do not run tools or edit files: ${marker}`,
    query,
    runner,
  );
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  while (Date.now() - startedAt <= timeoutMs) {
    const latest = await readTmuxCodexSessionByPaneId(session.paneId, query, runner);
    if (latest?.contents.includes(`• ${marker}`)) {
      return {
        marker,
        session: latest,
        observed: true,
        elapsedMs: Date.now() - startedAt,
      };
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  return {
    marker,
    session,
    observed: false,
    elapsedMs: Date.now() - startedAt,
  };
}

function collapsePromptWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function buildTerminalCodexAskPrompt(prompt: string, marker: string): string {
  const normalizedPrompt = collapsePromptWhitespace(prompt);
  return [
    normalizedPrompt,
    "Do not include progress logs, tool summaries, or narration in the final answer.",
    `After completing the request, end with this exact final line: ${marker}`,
  ].join(" ");
}

function contentSinceBefore(contentsBefore: string, contentsAfter: string): string {
  const beforeIndex = contentsAfter.lastIndexOf(contentsBefore);
  if (beforeIndex >= 0) {
    return contentsAfter.slice(beforeIndex + contentsBefore.length);
  }
  const maxOverlap = Math.min(contentsBefore.length, contentsAfter.length);
  for (let length = maxOverlap; length > 0; length -= 1) {
    if (contentsBefore.slice(-length) === contentsAfter.slice(0, length)) {
      return contentsAfter.slice(length);
    }
  }
  return contentsAfter;
}

function pruneCodexTuiProgressLines(lines: string[]): string[] {
  const result: string[] = [];
  let skippingToolTree = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const withoutBullet = trimmed.replace(/^•\s*/, "");
    if (/^[─_\-=]{3,}$/.test(trimmed)) {
      continue;
    }
    if (/^(?:Explored|Ran|Read|Listed|Searched|Opened|Checked|Inspected|Edited|Updated|Used)\b/i.test(withoutBullet)) {
      skippingToolTree = true;
      continue;
    }
    if (skippingToolTree && (/^[└├│]/.test(trimmed) || /^[\s]+[└├│]/.test(line))) {
      continue;
    }
    skippingToolTree = false;
    result.push(line);
  }
  return result;
}

export function extractTerminalCodexAnswerText(text: string, marker: string): string | null {
  const lines = text.split("\n");
  let markerLineIndex = -1;
  let firstAnswerLine = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const normalized = lines[index]!.trim().replace(/^•\s*/, "");
    if (normalized !== marker) {
      continue;
    }
    const previousPromptLine = lines
      .slice(0, index)
      .findLastIndex(line => line.trimStart().startsWith("›"));
    const answerLine = lines.findIndex((line, lineIndex) =>
      lineIndex > previousPromptLine
      && lineIndex < index
      && line.trimStart().startsWith("•")
      && !line.includes(marker)
    );
    if (answerLine >= 0) {
      markerLineIndex = index;
      firstAnswerLine = answerLine;
      break;
    }
  }
  if (markerLineIndex < 0 || firstAnswerLine < 0) {
    return null;
  }
  let answerLines = lines.slice(firstAnswerLine, markerLineIndex);
  while (answerLines.length > 0 && answerLines[0]!.trim() === "") {
    answerLines = answerLines.slice(1);
  }
  while (answerLines.length > 0 && answerLines.at(-1)!.trim() === "") {
    answerLines = answerLines.slice(0, -1);
  }
  answerLines = pruneCodexTuiProgressLines(answerLines);
  while (answerLines.length > 0 && answerLines[0]!.trim() === "") {
    answerLines = answerLines.slice(1);
  }
  while (answerLines.length > 0 && answerLines.at(-1)!.trim() === "") {
    answerLines = answerLines.slice(0, -1);
  }
  if (answerLines.length === 0) {
    return "";
  }
  answerLines[0] = answerLines[0]!.replace(/^\s*•\s?/, "");
  return answerLines
    .filter(line => !line.includes(marker))
    .join("\n")
    .trim();
}

export async function startTmuxCodexAsk(
  prompt: string,
  query: TmuxCodexQuery,
  runner: TmuxCodexExec = defaultRunner,
): Promise<TmuxCodexAskStart> {
  const marker = `${TERMINAL_DONE_PREFIX}${Date.now()}`;
  const status = await getTmuxCodexStatus(query, runner);
  if (!status.session) {
    throw new Error(status.blocker ?? "No matching tmux Codex CLI session was found.");
  }
  if (!status.ready) {
    throw new Error(status.blocker ?? "Codex CLI session is not ready.");
  }
  const submittedPrompt = buildTerminalCodexAskPrompt(prompt, marker);
  await submitTmuxText(status.session.paneId, submittedPrompt, runner);
  return {
    marker,
    session: status.session,
    submittedPrompt,
    contentsBefore: status.session.contents,
    startedAt: Date.now(),
  };
}

export async function waitForTmuxCodexAskCompletion(
  started: TmuxCodexAskStart,
  query: TmuxCodexQuery,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
  runner: TmuxCodexExec = defaultRunner,
): Promise<TmuxCodexAskResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  while (Date.now() - started.startedAt <= timeoutMs) {
    const latest = await readTmuxCodexSessionByPaneId(started.session.paneId, query, runner);
    if (latest) {
      const newText = contentSinceBefore(started.contentsBefore, latest.contents);
      const answerText = extractTerminalCodexAnswerText(newText, started.marker);
      if (answerText !== null) {
        return {
          marker: started.marker,
          session: latest,
          observed: true,
          elapsedMs: Date.now() - started.startedAt,
          answerText,
        };
      }
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  return {
    marker: started.marker,
    session: started.session,
    observed: false,
    elapsedMs: Date.now() - started.startedAt,
    answerText: null,
  };
}
