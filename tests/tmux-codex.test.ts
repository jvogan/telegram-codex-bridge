import { afterEach, describe, expect, test, vi } from "vitest";

import {
  getTmuxCodexStatus,
  pingTmuxCodex,
  sendTmuxCodexControl,
  setTmuxCodexOwner,
  startTmuxCodexAsk,
  startTmuxCodexSession,
  stopTmuxCodexSession,
  tmuxSessionExists,
  waitForTmuxCodexAskCompletion,
  type TmuxCodexExec,
} from "../src/core/terminal/tmux-codex.js";

function createRunner(options: {
  paneRows?: string;
  capture?: string;
  psOutput?: string;
  onCommand?: (command: string, args: string[]) => void;
} = {}): TmuxCodexExec {
  let doneMarker: string | null = null;
  let ownerNonce: string | null = null;
  let launchHash: string | null = null;
  const paneRows = options.paneRows ?? "telegram-codex-bridge\t%1\t/dev/ttys004\t/tmp/telegram-codex-bridge\n";
  const capture = options.capture ?? "OpenAI Codex\ndirectory: /tmp/telegram-codex-bridge\n› Ready";
  const psOutput = options.psOutput ?? "ttys004 node /opt/homebrew/bin/codex\n";
  return {
    async execFile(command, args) {
      options.onCommand?.(command, args);
      if (command === "ps") {
        return { stdout: psOutput, stderr: "" };
      }
      if (command !== "tmux") {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "list-panes") {
        return { stdout: paneRows, stderr: "" };
      }
      if (args[0] === "has-session") {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "set-option") {
        if (args[3] === "@telegram-codex-bridge-owner-nonce") {
          ownerNonce = args[4] ?? null;
        }
        if (args[3] === "@telegram-codex-bridge-launch-args-hash") {
          launchHash = args[4] ?? null;
        }
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "show-options") {
        if (args[4] === "@telegram-codex-bridge-owner-nonce" && ownerNonce) {
          return { stdout: `${ownerNonce}\n`, stderr: "" };
        }
        if (args[4] === "@telegram-codex-bridge-launch-args-hash" && launchHash) {
          return { stdout: `${launchHash}\n`, stderr: "" };
        }
        throw new Error("unknown option");
      }
      if (args[0] === "capture-pane") {
        return {
          stdout: doneMarker
            ? `${capture}\n• Terminal answer\n${doneMarker}\n› Ready`
            : capture,
          stderr: "",
        };
      }
      if (args[0] === "send-keys") {
        const text = args.join(" ");
        doneMarker = text.match(/BRIDGE_TERMINAL_DONE_\d+/)?.[0] ?? doneMarker;
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
  };
}

describe("tmux Codex terminal lane", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("reports ready only when the tmux pane has a Codex process", async () => {
    const status = await getTmuxCodexStatus({
      sessionName: "telegram-codex-bridge",
      expectedDirectoryHint: "telegram-codex-bridge",
    }, createRunner());

    expect(status.ready).toBe(true);
    expect(status.session?.paneId).toBe("%1");
    expect(status.session?.tty).toBe("/dev/ttys004");
  });

  test("fails closed when multiple panes match", async () => {
    const status = await getTmuxCodexStatus({
      sessionName: "telegram-codex-bridge",
      expectedDirectoryHint: "telegram-codex-bridge",
    }, createRunner({
      paneRows: [
        "telegram-codex-bridge\t%1\t/dev/ttys004\t/tmp/telegram-codex-bridge",
        "telegram-codex-bridge\t%2\t/dev/ttys005\t/tmp/telegram-codex-bridge",
      ].join("\n"),
    }));

    expect(status.ready).toBe(false);
    expect(status.blocker).toContain("Multiple matching");
  });

  test("uses stable tmux commands for daemon-owned lifecycle", async () => {
    const commands: string[] = [];
    const runner = createRunner({
      onCommand(command, args) {
        commands.push([command, ...args].join(" "));
      },
    });

    await startTmuxCodexSession({
      sessionName: "bridge-cli",
      cwd: "/tmp/work",
      codexCommand: "codex",
    }, runner);
    await stopTmuxCodexSession("bridge-cli", {}, runner);

    expect(commands).toContain("tmux new-session -d -s bridge-cli -c /tmp/work codex");
    expect(commands).toContain("tmux kill-session -t bridge-cli");
  });

  test("stores owner metadata and verifies nonce before stopping a session", async () => {
    const commands: string[] = [];
    const runner = createRunner({
      onCommand(command, args) {
        commands.push([command, ...args].join(" "));
      },
    });

    expect(await tmuxSessionExists("bridge-cli", runner)).toBe(true);
    await setTmuxCodexOwner("bridge-cli", "nonce-1", "hash-1", runner);
    await stopTmuxCodexSession("bridge-cli", { ownerNonce: "nonce-1" }, runner);

    expect(commands).toContain("tmux set-option -t bridge-cli @telegram-codex-bridge-owner-nonce nonce-1");
    expect(commands).toContain("tmux set-option -t bridge-cli @telegram-codex-bridge-launch-args-hash hash-1");
    expect(commands).toContain("tmux show-options -v -t bridge-cli @telegram-codex-bridge-owner-nonce");
    expect(commands).toContain("tmux kill-session -t bridge-cli");
  });

  test("refuses to stop when owner nonce does not match", async () => {
    const runner = createRunner();

    await setTmuxCodexOwner("bridge-cli", "nonce-1", "hash-1", runner);
    await expect(stopTmuxCodexSession("bridge-cli", { ownerNonce: "nonce-2" }, runner))
      .rejects.toThrow("owner nonce");
  });

  test("rejects shell-shaped tmux Codex commands", async () => {
    const commands: string[] = [];
    const runner = createRunner({
      onCommand(command, args) {
        commands.push([command, ...args].join(" "));
      },
    });

    await expect(startTmuxCodexSession({
      sessionName: "bridge-cli",
      cwd: "/tmp/work",
      codexCommand: "codex; rm -rf /",
    }, runner)).rejects.toThrow("without whitespace or shell metacharacters");

    expect(commands).toEqual([]);
  });

  test("asks and captures the isolated answer by marker", async () => {
    const runner = createRunner();
    const started = await startTmuxCodexAsk("summarize this", {
      sessionName: "telegram-codex-bridge",
      expectedDirectoryHint: "telegram-codex-bridge",
    }, runner);
    const result = await waitForTmuxCodexAskCompletion(started, {
      sessionName: "telegram-codex-bridge",
      expectedDirectoryHint: "telegram-codex-bridge",
    }, { timeoutMs: 100, pollIntervalMs: 1 }, runner);

    expect(result.observed).toBe(true);
    expect(result.answerText).toBe("Terminal answer");
  });

  test("ping and control target the locked pane", async () => {
    const commands: string[] = [];
    const runner = createRunner({
      capture: "OpenAI Codex\ndirectory: /tmp/telegram-codex-bridge\n› Ready\n• BRIDGE_TERMINAL_LANE_OK_1",
      onCommand(command, args) {
        commands.push([command, ...args].join(" "));
      },
    });

    await pingTmuxCodex({
      sessionName: "telegram-codex-bridge",
      expectedDirectoryHint: "telegram-codex-bridge",
      expectedPaneId: "%1",
    }, { timeoutMs: 1, pollIntervalMs: 1 }, runner);
    await sendTmuxCodexControl("interrupt", {
      sessionName: "telegram-codex-bridge",
      expectedDirectoryHint: "telegram-codex-bridge",
      expectedPaneId: "%1",
    }, runner);

    expect(commands.some(command => command.includes("send-keys -t %1"))).toBe(true);
    expect(commands.some(command => command.includes("C-c"))).toBe(true);
  });

  test("ping does not treat the echoed prompt marker as a reply", async () => {
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(1234)
      .mockReturnValueOnce(1234)
      .mockReturnValueOnce(1234)
      .mockReturnValue(1236);
    const runner = createRunner({
      capture: [
        "OpenAI Codex",
        "directory: /tmp/telegram-codex-bridge",
        "› Reply with exactly this single line and do not run tools or edit files: BRIDGE_TERMINAL_LANE_OK_1234",
        "› Ready",
      ].join("\n"),
    });

    const result = await pingTmuxCodex({
      sessionName: "telegram-codex-bridge",
      expectedDirectoryHint: "telegram-codex-bridge",
      expectedPaneId: "%1",
    }, { timeoutMs: 0, pollIntervalMs: 1 }, runner);

    expect(result.observed).toBe(false);
  });
});
