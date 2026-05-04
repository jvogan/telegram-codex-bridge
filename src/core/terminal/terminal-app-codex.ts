import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const CONTENT_MARKER = "__BRIDGE_TERMINAL_APP_CODEX_CONTENT__";
const AMBIGUOUS_MARKER = "__BRIDGE_TERMINAL_APP_CODEX_AMBIGUOUS__";
const DEFAULT_SESSION_NAME = "telegram-codex-bridge-terminal";

export interface TerminalAppCodexQuery {
  nameContains?: string;
  expectedDirectoryHint?: string;
  expectedTty?: string | null;
}

export interface TerminalAppCodexSession {
  tty: string;
  name: string;
  contents: string;
}

export interface TerminalAppCodexStatus {
  found: boolean;
  ready: boolean;
  session: TerminalAppCodexSession | null;
  blocker: string | null;
}

interface TerminalAppCodexFindResult {
  session: TerminalAppCodexSession | null;
  ambiguous: boolean;
}

export interface TerminalAppCodexExec {
  execFile(command: string, args: string[], options?: { timeout?: number; maxBuffer?: number }): Promise<{ stdout: string; stderr: string }>;
}

const defaultRunner: TerminalAppCodexExec = {
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

function parseSessionOutput(output: string): TerminalAppCodexSession | null {
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

function sessionFinderScript(query: Required<TerminalAppCodexQuery>): string {
  const nameContains = appleScriptString(query.nameContains);
  const expectedDirectoryHint = appleScriptString(query.expectedDirectoryHint);
  const expectedTty = query.expectedTty ? appleScriptString(normalizeTty(query.expectedTty)) : null;
  const ttyCondition = expectedTty ? ` and (tty of t as text) is ${expectedTty}` : "";
  const marker = appleScriptString(CONTENT_MARKER);
  const ambiguousMarker = appleScriptString(AMBIGUOUS_MARKER);
  return `
tell application "Terminal"
  set matches to {}
  repeat with w in windows
    try
      set windowTabs to tabs of w
      repeat with t in windowTabs
        try
          set tabName to custom title of t as text
          if tabName is "" then set tabName to name of w as text
          set tabContents to contents of t
          if tabName contains ${nameContains} and tabContents contains "OpenAI Codex" and tabContents contains ${expectedDirectoryHint}${ttyCondition} then
            set end of matches to ((tty of t as text) & "\\n" & tabName & "\\n" & ${marker} & "\\n" & tabContents)
          end if
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

async function runAppleScript(script: string, runner: TerminalAppCodexExec = defaultRunner): Promise<string> {
  const { stdout } = await runner.execFile("osascript", ["-e", script], {
    timeout: 10_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trimEnd();
}

async function ttyHasCodexProcess(tty: string, runner: TerminalAppCodexExec = defaultRunner): Promise<boolean> {
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

function parseSessionFindOutput(output: string): TerminalAppCodexFindResult {
  if (output.startsWith(AMBIGUOUS_MARKER)) {
    return { session: null, ambiguous: true };
  }
  return {
    session: parseSessionOutput(output),
    ambiguous: false,
  };
}

export function isTerminalAppCodexSessionReady(session: TerminalAppCodexSession): { ready: boolean; blocker: string | null } {
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

export async function findTerminalAppCodexSession(
  query: TerminalAppCodexQuery,
  runner: TerminalAppCodexExec = defaultRunner,
): Promise<TerminalAppCodexSession | null> {
  const resolved = {
    nameContains: query.nameContains ?? DEFAULT_SESSION_NAME,
    expectedDirectoryHint: query.expectedDirectoryHint ?? "",
    expectedTty: query.expectedTty ?? null,
  };
  return parseSessionFindOutput(await runAppleScript(sessionFinderScript(resolved), runner)).session;
}

export async function getTerminalAppCodexStatus(
  query: TerminalAppCodexQuery,
  runner: TerminalAppCodexExec = defaultRunner,
): Promise<TerminalAppCodexStatus> {
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
      blocker: "Multiple matching Terminal.app Codex CLI tabs were found; lock a specific TTY before sending work.",
    };
  }
  const session = found.session;
  if (!session) {
    return {
      found: false,
      ready: false,
      session: null,
      blocker: "No matching Terminal.app Codex CLI session was found.",
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
  const readiness = isTerminalAppCodexSessionReady(session);
  return {
    found: true,
    ready: readiness.ready,
    session,
    blocker: readiness.blocker,
  };
}

export async function sendTerminalAppCodexControl(
  control: "interrupt" | "clear",
  query: TerminalAppCodexQuery,
  runner: TerminalAppCodexExec = defaultRunner,
): Promise<TerminalAppCodexSession> {
  const status = await getTerminalAppCodexStatus(query, runner);
  if (!status.session) {
    throw new Error(status.blocker ?? "No matching Terminal.app Codex CLI session was found.");
  }
  if (control === "clear" && !status.ready) {
    throw new Error(status.blocker ?? "Codex CLI session is not ready.");
  }
  throw new Error("Terminal.app terminal lane control commands are not supported safely; use iTerm2 or tmux for interrupt/clear.");
}
