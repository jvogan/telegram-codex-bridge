import { describe, expect, test } from "vitest";

import {
  getTerminalAppCodexStatus,
  type TerminalAppCodexExec,
} from "../src/core/terminal/terminal-app-codex.js";

function sessionOutput(contents: string): string {
  return [
    "/dev/ttys010",
    "telegram-codex-bridge-terminal",
    "__BRIDGE_TERMINAL_APP_CODEX_CONTENT__",
    contents,
  ].join("\n");
}

function createRunner(options: {
  scriptOutput?: string;
  psOutput?: string;
} = {}): TerminalAppCodexExec {
  const scriptOutput = options.scriptOutput ?? sessionOutput("OpenAI Codex\ndirectory: /tmp/telegram-codex-bridge\n› Ready");
  const psOutput = options.psOutput ?? "ttys010 node /opt/homebrew/bin/codex\n";
  return {
    async execFile(command) {
      if (command === "ps") {
        return { stdout: psOutput, stderr: "" };
      }
      return { stdout: scriptOutput, stderr: "" };
    },
  };
}

describe("Terminal.app Codex terminal lane", () => {
  test("reports a ready compatibility session", async () => {
    const status = await getTerminalAppCodexStatus({
      nameContains: "telegram-codex-bridge",
      expectedDirectoryHint: "telegram-codex-bridge",
    }, createRunner());

    expect(status.ready).toBe(true);
    expect(status.session?.tty).toBe("/dev/ttys010");
  });

  test("fails closed when multiple tabs match", async () => {
    const status = await getTerminalAppCodexStatus({
      nameContains: "telegram-codex-bridge",
      expectedDirectoryHint: "telegram-codex-bridge",
    }, createRunner({
      scriptOutput: "__BRIDGE_TERMINAL_APP_CODEX_AMBIGUOUS__\n2",
    }));

    expect(status.ready).toBe(false);
    expect(status.blocker).toContain("Multiple matching");
  });
});
