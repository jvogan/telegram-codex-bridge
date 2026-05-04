import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "vitest";

import { auditPublicRepo } from "../scripts/public-audit-lib.mjs";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function createTempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "telegram-codex-public-audit-"));
  tempRoots.push(root);
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  writeFileSync(join(root, ".gitignore"), ".bridge-data\n.env.local\n");
  writeFileSync(join(root, "README.md"), "# temp repo\n");
  return root;
}

describe("auditPublicRepo", () => {
  test("ignores gitignored local smoke artifacts", () => {
    const root = createTempRepo();
    mkdirSync(join(root, ".bridge-data"), { recursive: true });
    writeFileSync(join(root, ".bridge-data", "telegram-daemon.log"), "ignored");
    writeFileSync(join(root, ".env.local"), "TELEGRAM_BOT_TOKEN=test");

    expect(auditPublicRepo(root)).toEqual([]);
  });

  test("flags suspicious non-ignored local residue", () => {
    const root = createTempRepo();
    writeFileSync(join(root, "bridge.sqlite"), "sqlite");

    expect(auditPublicRepo(root)).toContain("bridge.sqlite: found local sqlite state file");
  });

  test("flags a non-ignored local env file", () => {
    const root = createTempRepo();
    writeFileSync(join(root, ".env"), "TELEGRAM_BOT_TOKEN=real-token");

    expect(auditPublicRepo(root)).toContain(".env: local runtime artifact exists and is not git-ignored");
  });

  test("flags legacy brand references case-insensitively", () => {
    const root = createTempRepo();
    // Construct the banned token via join so this test file itself does not
    // contain the literal word and trip the public audit.
    const legacyBrand = ["hype", "rion"].join("");
    writeFileSync(join(root, "legacy.md"), `Old daemon: ${legacyBrand}-telegram-daemon\n`);

    expect(auditPublicRepo(root)).toContain("legacy.md: found legacy private brand");
  });

  test("allows GitHub handles in CODEOWNERS without flagging them as Telegram handles", () => {
    const root = createTempRepo();
    // Use an all-alphanumeric handle so the telegram-handle regex would fire
    // without the skip rule. Handles with hyphens are ignored by the regex
    // because `-` is not in its character class. Built via join to keep the
    // literal out of this test file.
    const handle = "@" + ["some", "owner"].join("");
    writeFileSync(join(root, "CODEOWNERS"), `* ${handle}\n`);

    const failures = auditPublicRepo(root);
    const handleFailures = failures.filter(f => f.includes("telegram handle-like token"));
    expect(handleFailures).toEqual([]);
  });

  test("still flags handle-like tokens outside CODEOWNERS", () => {
    const root = createTempRepo();
    const handle = "@" + ["some", "one"].join("");
    writeFileSync(join(root, "notes.md"), `Ping ${handle} for details.\n`);

    expect(auditPublicRepo(root)).toContain("notes.md: found telegram handle-like token");
  });

  test("allows known package-lock funding URLs without allowing the host elsewhere", () => {
    const root = createTempRepo();
    const fundingUrl = ["https://", "paypal.me", "/jimmywarting"].join("");
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({
      packages: {
        "node_modules/example": {
          funding: { url: fundingUrl },
        },
      },
    }));
    writeFileSync(join(root, "README.md"), `Donate at ${fundingUrl}\n`);

    const failures = auditPublicRepo(root);

    expect(failures).not.toContain("package-lock.json: found unallowlisted URL host paypal.me");
    expect(failures).toContain("README.md: found unallowlisted URL host paypal.me");
  });
});
