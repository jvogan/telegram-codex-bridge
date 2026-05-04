import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "vitest";

import { readPidFile, removePidFile, writePidFile } from "../src/core/util/pid.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function makePidPath(): string {
  const root = mkdtempSync(join(tmpdir(), "telegram-codex-bridge-pid-"));
  tempRoots.push(root);
  return join(root, "telegram-daemon.pid");
}

describe("pid utilities", () => {
  test("removePidFile only removes the file when owned by the provided pid", async () => {
    const pidPath = makePidPath();
    await writePidFile(pidPath, 12345);

    await removePidFile(pidPath, 99999);
    expect(await readPidFile(pidPath)).toBe(12345);
    expect(readFileSync(pidPath, "utf8")).toContain("12345");

    await removePidFile(pidPath, 12345);
    expect(await readPidFile(pidPath)).toBeNull();
  });

  test("removePidFile without an owner pid still removes the file", async () => {
    const pidPath = makePidPath();
    await writePidFile(pidPath, 54321);

    await removePidFile(pidPath);
    expect(await readPidFile(pidPath)).toBeNull();
  });
});
