import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "vitest";

import { isAllowlistedSecretMatch, scanRepoForSecrets } from "../scripts/secret-scan-lib.mjs";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function createTempRepo({ initializeGit = true } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "telegram-codex-secret-scan-"));
  tempRoots.push(root);
  if (initializeGit) {
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  }
  writeFileSync(join(root, ".gitignore"), ".env.local\n.bridge-data\n*.log\n");
  writeFileSync(join(root, "README.md"), "# temp repo\n");
  return root;
}

describe("secret scan", () => {
  test("flags hard-coded secret-like values in tracked files", () => {
    const root = createTempRepo();
    const fakeKey = ["sk-", "abcdefghijklmnopqrstuvwxyz123456"].join("");
    writeFileSync(join(root, "bad.txt"), `OPENAI_API_KEY=${fakeKey}`);

    expect(scanRepoForSecrets(root)).toContain("bad.txt: found OpenAI-style secret");
  });

  test("allows documented placeholder snippets", () => {
    expect(isAllowlistedSecretMatch("docs/example.md", "000000000:TEST_TOKEN_FOR_DOCS_ONLY")).toBe(true);
  });

  test("respects .gitignore even when the directory is not a git checkout", () => {
    const root = createTempRepo({ initializeGit: false });
    const fakeKey = ["sk-", "abcdefghijklmnopqrstuvwxyz123456"].join("");
    writeFileSync(join(root, ".env.local"), `OPENAI_API_KEY=${fakeKey}`);
    writeFileSync(join(root, "bridge.log"), `OPENAI_API_KEY=${fakeKey}`);

    expect(scanRepoForSecrets(root)).toEqual([]);
  });
});
