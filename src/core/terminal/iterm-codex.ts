import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const CONTENT_MARKER = "__BRIDGE_ITERM_CODEX_CONTENT__";
const AMBIGUOUS_MARKER = "__BRIDGE_ITERM_CODEX_AMBIGUOUS__";
const DEFAULT_SESSION_NAME = "telegram-codex-bridge-terminal";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_ASK_TIMEOUT_MS = 10 * 60_000;
const TERMINAL_LANE_OK_PREFIX = "BRIDGE_TERMINAL_LANE_OK_";
const TERMINAL_DONE_PREFIX = "BRIDGE_TERMINAL_DONE_";

export interface ItermCodexSessionQuery {
  nameContains?: string;
  expectedDirectoryHint?: string;
  expectedTty?: string | null;
}

export interface ItermCodexSession {
  tty: string;
  name: string;
  contents: string;
}

export interface ItermCodexStatus {
  found: boolean;
  ready: boolean;
  session: ItermCodexSession | null;
  blocker: string | null;
}

interface ItermCodexFindResult {
  session: ItermCodexSession | null;
  ambiguous: boolean;
}

export interface ItermCodexPingResult {
  marker: string;
  session: ItermCodexSession;
  observed: boolean;
  elapsedMs: number;
}

export interface ItermCodexAskStart {
  marker: string;
  session: ItermCodexSession;
  submittedPrompt: string;
  contentsBefore: string;
  startedAt: number;
}

export interface ItermCodexAskResult {
  marker: string;
  session: ItermCodexSession;
  observed: boolean;
  elapsedMs: number;
  answerText: string | null;
}

export interface ItermCodexExec {
  execFile(command: string, args: string[], options?: { timeout?: number; maxBuffer?: number }): Promise<{ stdout: string; stderr: string }>;
}

const defaultRunner: ItermCodexExec = {
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

function appleScriptString(value: string): string {
  return JSON.stringify(value);
}

function normalizeTty(value: string): string {
  return value.startsWith("/dev/") ? value : `/dev/${value}`;
}

function ttyName(value: string): string {
  return normalizeTty(value).replace(/^\/dev\//, "");
}

function collapsePromptWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function parseSessionOutput(output: string): ItermCodexSession | null {
  const markerIndex = output.indexOf(`\n${CONTENT_MARKER}\n`);
  if (markerIndex < 0) {
    return null;
  }
  const header = output.slice(0, markerIndex).split("\n");
  const tty = header[0]?.trim();
  const name = header[1]?.trim();
  if (!tty || !name) {
    return null;
  }
  return {
    tty: normalizeTty(tty),
    name,
    contents: output.slice(markerIndex + CONTENT_MARKER.length + 2),
  };
}

function sessionFinderScript(query: Required<ItermCodexSessionQuery>): string {
  const nameContains = appleScriptString(query.nameContains);
  const expectedDirectoryHint = appleScriptString(query.expectedDirectoryHint);
  const expectedTty = query.expectedTty ? appleScriptString(normalizeTty(query.expectedTty)) : null;
  const ttyCondition = expectedTty ? ` and (tty of s as text) is ${expectedTty}` : "";
  const marker = appleScriptString(CONTENT_MARKER);
  const ambiguousMarker = appleScriptString(AMBIGUOUS_MARKER);
  return `
tell application "iTerm2"
  set matches to {}
  repeat with w in windows
    try
      set windowTabs to tabs of w
      repeat with tabRef in windowTabs
        try
          set tabSessions to sessions of tabRef
          repeat with s in tabSessions
            try
              set sessionName to name of s as text
              set sessionContents to contents of s
              if sessionName contains ${nameContains} and sessionContents contains "OpenAI Codex" and sessionContents contains ${expectedDirectoryHint}${ttyCondition} then
                set end of matches to ((tty of s as text) & "\\n" & sessionName & "\\n" & ${marker} & "\\n" & sessionContents)
              end if
            end try
          end repeat
        end try
      end repeat
    end try
  end repeat
  if (count of matches) is 1 then return item 1 of matches
  if (count of matches) is greater than 1 then return (${ambiguousMarker} & "\\n" & (count of matches as text))
end tell
return ""
`;
}

function sendControlScript(tty: string, nameContains: string, control: "interrupt" | "clear"): string {
  const targetTty = appleScriptString(normalizeTty(tty));
  const sessionName = appleScriptString(nameContains);
  const command = control === "interrupt"
    ? "write s text (ASCII character 3) newline no"
    : "write s text \"/clear\" newline no\n          delay 0.1\n          write s text (ASCII character 13) newline no";
  return `
tell application "iTerm2"
  repeat with w in windows
    try
      set windowTabs to tabs of w
      repeat with t in windowTabs
        try
          set tabSessions to sessions of t
          repeat with s in tabSessions
            try
              set sessionName to name of s as text
              if (tty of s as text) is ${targetTty} and sessionName contains ${sessionName} then
                ${command}
                return "sent"
              end if
            end try
          end repeat
        end try
      end repeat
    end try
  end repeat
end tell
return ""
`;
}

function sessionContentsByTtyScript(tty: string, nameContains: string): string {
  const targetTty = appleScriptString(normalizeTty(tty));
  const sessionName = appleScriptString(nameContains);
  const marker = appleScriptString(CONTENT_MARKER);
  return `
tell application "iTerm2"
  repeat with w in windows
    try
      set windowTabs to tabs of w
      repeat with t in windowTabs
        try
          set tabSessions to sessions of t
          repeat with s in tabSessions
            try
              set sessionName to name of s as text
              if (tty of s as text) is ${targetTty} and sessionName contains ${sessionName} then
                return ((tty of s as text) & "\\n" & sessionName & "\\n" & ${marker} & "\\n" & (contents of s))
              end if
            end try
          end repeat
        end try
      end repeat
    end try
  end repeat
end tell
return ""
`;
}

function sendPromptScript(tty: string, nameContains: string, prompt: string): string {
  const targetTty = appleScriptString(normalizeTty(tty));
  const sessionName = appleScriptString(nameContains);
  const promptText = appleScriptString(prompt);
  return `
tell application "iTerm2"
  repeat with w in windows
    try
      set windowTabs to tabs of w
      repeat with t in windowTabs
        try
          set tabSessions to sessions of t
          repeat with s in tabSessions
            try
              set sessionName to name of s as text
              if (tty of s as text) is ${targetTty} and sessionName contains ${sessionName} then
                write s text ${promptText} newline no
                delay 0.1
                write s text (ASCII character 13) newline no
                return "sent"
              end if
            end try
          end repeat
        end try
      end repeat
    end try
  end repeat
end tell
return ""
`;
}

async function runAppleScript(script: string, runner: ItermCodexExec = defaultRunner): Promise<string> {
  const { stdout } = await runner.execFile("osascript", ["-e", script], {
    timeout: 10_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trimEnd();
}

function parseSessionFindOutput(output: string): ItermCodexFindResult {
  if (output.startsWith(AMBIGUOUS_MARKER)) {
    return { session: null, ambiguous: true };
  }
  return {
    session: parseSessionOutput(output),
    ambiguous: false,
  };
}

async function ttyHasCodexProcess(tty: string, runner: ItermCodexExec = defaultRunner): Promise<boolean> {
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

export function isItermCodexSessionReady(session: ItermCodexSession): { ready: boolean; blocker: string | null } {
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

export async function findItermCodexSession(
  query: ItermCodexSessionQuery,
  runner: ItermCodexExec = defaultRunner,
): Promise<ItermCodexSession | null> {
  const resolved = {
    nameContains: query.nameContains ?? DEFAULT_SESSION_NAME,
    expectedDirectoryHint: query.expectedDirectoryHint ?? "",
    expectedTty: query.expectedTty ?? null,
  };
  return parseSessionFindOutput(await runAppleScript(sessionFinderScript(resolved), runner)).session;
}

export async function getItermCodexStatus(
  query: ItermCodexSessionQuery,
  runner: ItermCodexExec = defaultRunner,
): Promise<ItermCodexStatus> {
  const resolved = {
    nameContains: query.nameContains ?? DEFAULT_SESSION_NAME,
    expectedDirectoryHint: query.expectedDirectoryHint ?? "",
    expectedTty: query.expectedTty ?? null,
  };
  const found = parseSessionFindOutput(await runAppleScript(sessionFinderScript(resolved), runner));
  if (found.ambiguous) {
    return {
      found: false,
      ready: false,
      session: null,
      blocker: "Multiple matching iTerm2 Codex CLI sessions were found; lock a specific TTY before sending work.",
    };
  }
  const session = found.session;
  if (!session) {
    return {
      found: false,
      ready: false,
      session: null,
      blocker: "No matching iTerm2 Codex CLI session was found.",
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
  const readiness = isItermCodexSessionReady(session);
  return {
    found: true,
    ready: readiness.ready,
    session,
    blocker: readiness.blocker,
  };
}

export async function sendItermCodexPrompt(
  prompt: string,
  query: ItermCodexSessionQuery,
  runner: ItermCodexExec = defaultRunner,
): Promise<ItermCodexSession> {
  const status = await getItermCodexStatus(query, runner);
  if (!status.session) {
    throw new Error(status.blocker ?? "No matching iTerm2 Codex CLI session was found.");
  }
  if (!status.ready) {
    throw new Error(status.blocker ?? "Codex CLI session is not ready.");
  }
  const output = await runAppleScript(sendPromptScript(status.session.tty, query.nameContains ?? DEFAULT_SESSION_NAME, prompt), runner);
  if (output !== "sent") {
    throw new Error("iTerm2 Codex CLI session disappeared before the prompt could be sent.");
  }
  return status.session;
}

export async function sendItermCodexControl(
  control: "interrupt" | "clear",
  query: ItermCodexSessionQuery,
  runner: ItermCodexExec = defaultRunner,
): Promise<ItermCodexSession> {
  const status = await getItermCodexStatus(query, runner);
  if (!status.session) {
    throw new Error(status.blocker ?? "No matching iTerm2 Codex CLI session was found.");
  }
  if (control === "clear" && !status.ready) {
    throw new Error(status.blocker ?? "Codex CLI session is not ready.");
  }
  const output = await runAppleScript(sendControlScript(status.session.tty, query.nameContains ?? DEFAULT_SESSION_NAME, control), runner);
  if (output !== "sent") {
    throw new Error("iTerm2 Codex CLI session disappeared before the control command could be sent.");
  }
  return status.session;
}

export async function readItermCodexSessionByTty(
  tty: string,
  query: ItermCodexSessionQuery,
  runner: ItermCodexExec = defaultRunner,
): Promise<ItermCodexSession | null> {
  return parseSessionOutput(await runAppleScript(
    sessionContentsByTtyScript(tty, query.nameContains ?? DEFAULT_SESSION_NAME),
    runner,
  ));
}

export async function pingItermCodex(
  query: ItermCodexSessionQuery,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
  runner: ItermCodexExec = defaultRunner,
): Promise<ItermCodexPingResult> {
  const marker = `${TERMINAL_LANE_OK_PREFIX}${Date.now()}`;
  const startedAt = Date.now();
  const session = await sendItermCodexPrompt(
    `Reply with exactly this single line and do not run tools or edit files: ${marker}`,
    query,
    runner,
  );
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  while (Date.now() - startedAt <= timeoutMs) {
    const latest = await readItermCodexSessionByTty(session.tty, query, runner);
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

export function extractItermCodexAnswerText(text: string, marker: string): string | null {
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

export function buildItermCodexAskPrompt(prompt: string, marker: string): string {
  const normalizedPrompt = collapsePromptWhitespace(prompt);
  return [
    normalizedPrompt,
    "Do not include progress logs, tool summaries, or narration in the final answer.",
    `After completing the request, end with this exact final line: ${marker}`,
  ].join(" ");
}

export async function startItermCodexAsk(
  prompt: string,
  query: ItermCodexSessionQuery,
  runner: ItermCodexExec = defaultRunner,
): Promise<ItermCodexAskStart> {
  const marker = `${TERMINAL_DONE_PREFIX}${Date.now()}`;
  const status = await getItermCodexStatus(query, runner);
  if (!status.session) {
    throw new Error(status.blocker ?? "No matching iTerm2 Codex CLI session was found.");
  }
  if (!status.ready) {
    throw new Error(status.blocker ?? "Codex CLI session is not ready.");
  }
  const submittedPrompt = buildItermCodexAskPrompt(prompt, marker);
  const output = await runAppleScript(sendPromptScript(status.session.tty, query.nameContains ?? DEFAULT_SESSION_NAME, submittedPrompt), runner);
  if (output !== "sent") {
    throw new Error("iTerm2 Codex CLI session disappeared before the prompt could be sent.");
  }
  return {
    marker,
    session: status.session,
    submittedPrompt,
    contentsBefore: status.session.contents,
    startedAt: Date.now(),
  };
}

export async function waitForItermCodexAskCompletion(
  started: ItermCodexAskStart,
  query: ItermCodexSessionQuery,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
  runner: ItermCodexExec = defaultRunner,
): Promise<ItermCodexAskResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  while (Date.now() - started.startedAt <= timeoutMs) {
    const latest = await readItermCodexSessionByTty(started.session.tty, query, runner);
    if (latest) {
      const newText = contentSinceBefore(started.contentsBefore, latest.contents);
      const answerText = extractItermCodexAnswerText(newText, started.marker);
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

export async function askItermCodex(
  prompt: string,
  query: ItermCodexSessionQuery,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
  runner: ItermCodexExec = defaultRunner,
): Promise<ItermCodexAskResult> {
  const started = await startItermCodexAsk(prompt, query, runner);
  return await waitForItermCodexAskCompletion(started, query, options, runner);
}
