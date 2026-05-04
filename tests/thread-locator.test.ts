import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import { DesktopThreadLocator } from "../src/core/desktop/thread-locator.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function makeLocatorSetup() {
  const root = mkdtempSync(join(tmpdir(), "telegram-codex-bridge-locator-"));
  tempRoots.push(root);
  const dbPath = join(root, "state.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      model_provider TEXT NOT NULL DEFAULT 'openai',
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      sandbox_policy TEXT NOT NULL DEFAULT 'workspace-write',
      approval_mode TEXT NOT NULL DEFAULT 'on-request',
      tokens_used INTEGER NOT NULL DEFAULT 0,
      has_user_event INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0
    );
  `);
  return { root, db, locator: new DesktopThreadLocator(dbPath) };
}

describe("DesktopThreadLocator", () => {
  test("bind-current rejects ambiguous recent threads", () => {
    const { root, db, locator } = makeLocatorSetup();
    const rolloutA = join(root, "a.jsonl");
    const rolloutB = join(root, "b.jsonl");
    writeFileSync(rolloutA, "", "utf8");
    writeFileSync(rolloutB, "", "utf8");
    db.prepare(`
      INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, title)
      VALUES (?, ?, ?, ?, 'vscode', ?, ?)
    `).run("thread-a", rolloutA, 100, 200, "/tmp/workspace", "A");
    db.prepare(`
      INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, title)
      VALUES (?, ?, ?, ?, 'vscode', ?, ?)
    `).run("thread-b", rolloutB, 101, 199, "/tmp/workspace", "B");

    expect(() => locator.bindCurrent({ cwd: "/tmp/workspace", recentWindowSeconds: 10 })).toThrow("bind-current is ambiguous");
    db.close();
  });
});
