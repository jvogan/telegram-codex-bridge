import { describe, expect, test } from "vitest";

import { parseLsofCwd, parsePsProcessList, processCommandMatchesPattern } from "../src/core/util/process.js";
import { REALTIME_GATEWAY_PROCESS_PATTERN, TELEGRAM_DAEMON_PROCESS_PATTERN } from "../src/core/util/process-patterns.js";

describe("process util parsing", () => {
  test("parses ps output into running processes", () => {
    const parsed = parsePsProcessList([
      "  123 bridge-telegram-daemon",
      "456 node /tmp/example.js",
      "",
      "bad line",
    ].join("\n"));

    expect(parsed).toEqual([
      { pid: 123, command: "bridge-telegram-daemon" },
      { pid: 456, command: "node /tmp/example.js" },
    ]);
  });

  test("parses lsof cwd output", () => {
    const cwd = parseLsofCwd([
      "p123",
      "fcwd",
      "n/tmp/example-project",
    ].join("\n"));

    expect(cwd).toBe("/tmp/example-project");
  });

  test("returns null when lsof cwd output is missing", () => {
    expect(parseLsofCwd("p123\nfcwd\n")).toBeNull();
  });

  test("does not treat arbitrary pid commands as managed bridge processes", () => {
    expect(processCommandMatchesPattern("node /tmp/example.js", TELEGRAM_DAEMON_PROCESS_PATTERN)).toBe(false);
    expect(processCommandMatchesPattern("node /repo/dist/bin/telegram-daemon.js", TELEGRAM_DAEMON_PROCESS_PATTERN)).toBe(true);
    expect(processCommandMatchesPattern("telegram-codex-bridge-daemon", TELEGRAM_DAEMON_PROCESS_PATTERN)).toBe(true);
    expect(processCommandMatchesPattern("telegram-codex-bridge-realtime-gateway", REALTIME_GATEWAY_PROCESS_PATTERN)).toBe(true);
  });
});
