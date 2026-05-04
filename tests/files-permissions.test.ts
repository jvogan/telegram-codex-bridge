import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ensureDir, ensurePrivateFile } from "../src/core/util/files.js";

describe("private file helpers", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps storage directories private", () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-bridge-files-"));
    roots.push(root);
    const path = join(root, "storage");

    ensureDir(path);

    expect(statSync(path).mode & 0o777).toBe(0o700);
  });

  test("keeps existing state and log files private", () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-bridge-files-"));
    roots.push(root);
    const path = join(root, "bridge.sqlite");
    writeFileSync(path, "");
    chmodSync(path, 0o644);

    ensurePrivateFile(path);

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
