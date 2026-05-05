import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  buildTerminalCodexLaunchPlan,
  persistableTerminalCodexAskStart,
  sanitizeTerminalErrorText,
} from "../src/core/terminal/codex-terminal.js";
import { createTestBridgeConfig } from "./helpers/test-config.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "telegram-codex-terminal-"));
  tempRoots.push(root);
  return root;
}

describe("terminal Codex shared helpers", () => {
  test("redacts common secret-shaped terminal errors", () => {
    const privatePath = ["", "Users", "example", "private"].join("/");
    expect(sanitizeTerminalErrorText(`failed with api_token=abc123 control_secret=def456 ${privatePath}`)).toBe(
      "failed with token=[redacted] secret=[redacted] ~/private",
    );
  });

  test("compacts osascript failures without leaking script bodies", () => {
    const privatePath = ["", "Users", "example", "project", "secret"].join("/");
    const raw = [
      "Command failed: osascript -e tell application \"iTerm2\"",
      "  repeat with w in windows",
      `    set scriptPath to "${privatePath}"`,
      "  end repeat",
      "end tell",
      "120:133: execution error: iTerm2 got an error: Can't get tab 1 of window id 123. (-1728)",
    ].join("\n");

    expect(sanitizeTerminalErrorText(new Error(raw))).toBe(
      "Terminal automation failed: iTerm2 got an error: Can't get tab 1 of window id 123.",
    );
  });

  test("builds public-safe launch args without workspace write or approval prompts", () => {
    const root = tempRoot();
    const config = createTestBridgeConfig(root, {
      terminal_lane: {
        enabled: true,
        session_name: "telegram-codex-bridge-terminal",
        workdir: join(root, "terminal-work"),
        codex_command: "/opt/homebrew/bin/codex",
        model: "gpt-5.5",
        codex_profile: "bridge-terminal",
      },
    });
    const plan = buildTerminalCodexLaunchPlan(config);

    expect(plan.args).toContain("--cd");
    expect(plan.args).toContain("-c");
    expect(plan.args).toContain("check_for_update_on_startup=false");
    expect(plan.args).toContain(join(root, "terminal-work"));
    expect(plan.args).toContain("--sandbox");
    expect(plan.args).toContain("read-only");
    expect(plan.args).toContain("--ask-for-approval");
    expect(plan.args).toContain("never");
    expect(plan.args).toContain("--model");
    expect(plan.args).toContain("gpt-5.5");
    expect(plan.args).toContain("model_reasoning_effort=\"low\"");
    expect(plan.model).toBe("gpt-5.5");
    expect(plan.reasoningEffort).toBe("low");
    expect(plan.webSearch).toBe(true);
    expect(plan.args).toContain("--search");
    expect(plan.args).toContain("--profile");
    expect(plan.args).toContain("bridge-terminal");
    expect(plan.args).not.toContain("workspace-write");
    expect(plan.args).not.toContain("danger-full-access");
    expect(plan.launcherCommand).toMatch(/^\/bin\/sh /);
    expect(plan.attachCommand).toBe("tmux attach -t telegram-codex-bridge-terminal");
  });

  test("builds explicit power-user launch args with approval prompts", () => {
    const root = tempRoot();
    const config = createTestBridgeConfig(root, {
      terminal_lane: {
        enabled: true,
        profile: "power-user",
        sandbox: "workspace-write",
        approval_policy: "on-request",
      },
    });
    const plan = buildTerminalCodexLaunchPlan(config);

    expect(plan.profile).toBe("power-user");
    expect(plan.args).toContain("workspace-write");
    expect(plan.args).toContain("on-request");
    expect(plan.args).not.toContain("danger-full-access");
  });

  test("can explicitly disable terminal lane web search", () => {
    const root = tempRoot();
    const config = createTestBridgeConfig(root, {
      terminal_lane: {
        web_search: false,
      },
    });
    const plan = buildTerminalCodexLaunchPlan(config);

    expect(plan.webSearch).toBe(false);
    expect(plan.args).not.toContain("--search");
  });

  test("can launch a one-off public-safe profile from a stronger config", () => {
    const root = tempRoot();
    const config = createTestBridgeConfig(root, {
      terminal_lane: {
        profile: "power-user",
        sandbox: "workspace-write",
        approval_policy: "on-request",
      },
    });
    const plan = buildTerminalCodexLaunchPlan(config, { profile: "public-safe" });

    expect(plan.profile).toBe("public-safe");
    expect(plan.sandbox).toBe("read-only");
    expect(plan.approvalPolicy).toBe("never");
    expect(plan.args).toContain("read-only");
    expect(plan.args).toContain("never");
  });

  test("persisted terminal task metadata stores hashes instead of scrollback", () => {
    const persisted = persistableTerminalCodexAskStart({
      backend: "tmux",
      marker: "DONE",
      session: {
        backend: "tmux",
        tty: "/dev/ttys004",
        name: "telegram-codex-bridge-terminal",
        paneId: "%1",
        cwd: "/tmp/workdir",
        contents: "OpenAI Codex\nsecret scrollback",
      },
      submittedPrompt: "prompt text",
      contentsBefore: "private scrollback",
      startedAt: 123,
    });

    expect(JSON.stringify(persisted)).not.toContain("private scrollback");
    expect(JSON.stringify(persisted)).not.toContain("secret scrollback");
    expect(persisted.contentsBeforeHash).toHaveLength(64);
    expect(persisted.submittedPromptHash).toHaveLength(64);
  });
});
