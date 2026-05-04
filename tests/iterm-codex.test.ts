import { describe, expect, test } from "vitest";

import {
  askItermCodex,
  buildItermCodexAskPrompt,
  extractItermCodexAnswerText,
  getItermCodexStatus,
  isItermCodexSessionReady,
  pingItermCodex,
  sendItermCodexControl,
  sendItermCodexPrompt,
  type ItermCodexExec,
} from "../src/core/terminal/iterm-codex.js";

function sessionOutput(contents: string): string {
  return [
    "/dev/ttys004",
    "telegram-codex-bridge-terminal (codex)",
    "__BRIDGE_ITERM_CODEX_CONTENT__",
    contents,
  ].join("\n");
}

function createRunner(options: {
  sessionContents?: string;
  psOutput?: string;
  ambiguous?: boolean;
  onPrompt?: (script: string) => void;
} = {}): ItermCodexExec {
  let lastMarker: string | null = null;
  let doneMarker: string | null = null;
  let sentPrompt: string | null = null;
  const sessionContents = options.sessionContents ?? "OpenAI Codex\nmodel: gpt-5.5 low\ndirectory: /tmp/telegram-codex-bridge\n› Ready";
  const psOutput = options.psOutput ?? "ttys004 node /opt/homebrew/bin/codex\n";
  return {
    async execFile(command, args) {
      if (command === "ps") {
        return { stdout: psOutput, stderr: "" };
      }
      const script = args[1] ?? "";
      if (script.includes("write s text")) {
        lastMarker = script.match(/BRIDGE_TERMINAL_LANE_OK_\d+/)?.[0] ?? null;
        doneMarker = script.match(/BRIDGE_TERMINAL_DONE_\d+/)?.[0] ?? null;
        sentPrompt = script;
        options.onPrompt?.(script);
        return { stdout: "sent\n", stderr: "" };
      }
      if (script.includes("/dev/ttys999")) {
        return { stdout: "", stderr: "" };
      }
      if (script.includes("(tty of s as text) is")) {
        if (doneMarker) {
          return {
            stdout: sessionOutput([
              sessionContents,
              `› ${sentPrompt ?? ""}`,
              "",
              "• Terminal lane answer",
              "  second line",
              "",
              doneMarker,
              "",
              "› Ready",
            ].join("\n")),
            stderr: "",
          };
        }
        return {
          stdout: sessionOutput(`${sessionContents}\n${lastMarker ? `• ${lastMarker}` : ""}`),
          stderr: "",
        };
      }
      if (options.ambiguous) {
        return { stdout: "__BRIDGE_ITERM_CODEX_AMBIGUOUS__\n2", stderr: "" };
      }
      return { stdout: sessionOutput(sessionContents), stderr: "" };
    },
  };
}

describe("iTerm Codex terminal lane", () => {
  test("reports ready only when the named Codex session has a matching process", async () => {
    const status = await getItermCodexStatus({
      nameContains: "telegram-codex-bridge",
      expectedDirectoryHint: "telegram-codex-bridge",
    }, createRunner());

    expect(status.found).toBe(true);
    expect(status.ready).toBe(true);
    expect(status.session?.tty).toBe("/dev/ttys004");
  });

  test("fails closed when the tty no longer owns a Codex process", async () => {
    const status = await getItermCodexStatus({
      nameContains: "telegram-codex-bridge",
      expectedDirectoryHint: "telegram-codex-bridge",
    }, createRunner({ psOutput: "ttys004 /bin/zsh\n" }));

    expect(status.found).toBe(true);
    expect(status.ready).toBe(false);
    expect(status.blocker).toContain("No Codex CLI process");
  });

  test("fails closed when multiple iTerm2 sessions match", async () => {
    const status = await getItermCodexStatus({
      nameContains: "telegram-codex-bridge",
      expectedDirectoryHint: "telegram-codex-bridge",
    }, createRunner({ ambiguous: true }));

    expect(status.found).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.blocker).toContain("Multiple matching");
  });

  test("detects busy Codex CLI panes", () => {
    expect(isItermCodexSessionReady({
      tty: "/dev/ttys004",
      name: "telegram-codex-bridge",
      contents: "OpenAI Codex\nesc to interrupt\n›",
    })).toEqual({
      ready: false,
      blocker: "Codex CLI appears to be busy",
    });
  });

  test("sends prompts and controls through a verified session", async () => {
    let wrotePrompt = false;
    const session = await sendItermCodexPrompt("hello terminal lane", {
      nameContains: "telegram-codex-bridge",
      expectedDirectoryHint: "telegram-codex-bridge",
    }, createRunner({
      onPrompt(script) {
        wrotePrompt = script.includes("hello terminal lane") && script.includes("write s text");
      },
    }));

    expect(session.tty).toBe("/dev/ttys004");
    expect(wrotePrompt).toBe(true);

    let sentControl = false;
    await sendItermCodexControl("interrupt", {
      nameContains: "telegram-codex-bridge",
      expectedDirectoryHint: "telegram-codex-bridge",
    }, createRunner({
      onPrompt(script) {
        sentControl = script.includes("ASCII character 3");
      },
    }));
    expect(sentControl).toBe(true);
  });

  test("ping waits for the CLI reply marker, not just the submitted prompt", async () => {
    const result = await pingItermCodex({
      nameContains: "telegram-codex-bridge",
      expectedDirectoryHint: "telegram-codex-bridge",
    }, { timeoutMs: 100, pollIntervalMs: 1 }, createRunner());

    expect(result.observed).toBe(true);
    expect(result.marker).toMatch(/^BRIDGE_TERMINAL_LANE_OK_/);
  });

  test("builds and extracts marked ask answers", async () => {
    expect(buildItermCodexAskPrompt("  hello\nterminal   lane ", "DONE")).toBe(
      "hello terminal lane Do not include progress logs, tool summaries, or narration in the final answer. After completing the request, end with this exact final line: DONE",
    );
    expect(extractItermCodexAnswerText([
      "› please answer BRIDGE_TERMINAL_DONE_1",
      "",
      "• First line",
      "  second line",
      "",
      "BRIDGE_TERMINAL_DONE_1",
      "",
      "› Ready",
    ].join("\n"), "BRIDGE_TERMINAL_DONE_1")).toBe("First line\n  second line");

    const result = await askItermCodex("describe terminal lane", {
      nameContains: "telegram-codex-bridge",
      expectedDirectoryHint: "telegram-codex-bridge",
    }, { timeoutMs: 100, pollIntervalMs: 1 }, createRunner());

    expect(result.observed).toBe(true);
    expect(result.marker).toMatch(/^BRIDGE_TERMINAL_DONE_/);
    expect(result.answerText).toBe("Terminal lane answer\n  second line");
  });
});
