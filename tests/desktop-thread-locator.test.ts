import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function createLocatorFixture() {
  const root = mkdtempSync(join(tmpdir(), "telegram-codex-bridge-locator-"));
  tempRoots.push(root);
  const dbPath = join(root, "state_5.sqlite");
  const sessionsRoot = join(root, "sessions");
  mkdirSync(sessionsRoot, { recursive: true });
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
      archived INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER,
      git_sha TEXT,
      git_branch TEXT,
      git_origin_url TEXT,
      cli_version TEXT NOT NULL DEFAULT '',
      first_user_message TEXT NOT NULL DEFAULT '',
      agent_nickname TEXT,
      agent_role TEXT,
      memory_mode TEXT NOT NULL DEFAULT 'enabled',
      model TEXT,
      reasoning_effort TEXT,
      agent_path TEXT
    );
  `);

  function addThread(thread: { id: string; cwd: string; updatedAt: number; title: string; source?: string }) {
    const rolloutPath = join(sessionsRoot, `${thread.id}.jsonl`);
    writeFileSync(rolloutPath, "", "utf8");
    db.prepare(`
      INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, title)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      thread.id,
      rolloutPath,
      thread.updatedAt - 10,
      thread.updatedAt,
      thread.source ?? "vscode",
      thread.cwd,
      thread.title,
    );
    return rolloutPath;
  }

  return {
    db,
    locator: new DesktopThreadLocator(dbPath),
    addThread,
  };
}

describe("DesktopThreadLocator", () => {
  test("lists recent matching desktop threads for a cwd", () => {
    const fixture = createLocatorFixture();
    fixture.addThread({
      id: "thread-1",
      cwd: "/tmp/workspace-a",
      updatedAt: 1000,
      title: "A",
    });
    fixture.addThread({
      id: "thread-2",
      cwd: "/tmp/workspace-a",
      updatedAt: 900,
      title: "B",
    });
    fixture.addThread({
      id: "thread-3",
      cwd: "/tmp/workspace-b",
      updatedAt: 800,
      title: "C",
    });

    expect(fixture.locator.listMatchingDesktopThreads({ cwd: "/tmp/workspace-a" }).map(thread => thread.threadId))
      .toEqual(["thread-1", "thread-2"]);
    fixture.db.close();
  });

  test("bind-current returns the only matching desktop thread for a cwd", () => {
    const fixture = createLocatorFixture();
    fixture.addThread({
      id: "thread-1",
      cwd: "/tmp/workspace-a",
      updatedAt: 1000,
      title: "A",
    });
    fixture.addThread({
      id: "thread-2",
      cwd: "/tmp/workspace-b",
      updatedAt: 900,
      title: "B",
    });

    const binding = fixture.locator.bindCurrent({ cwd: "/tmp/workspace-a" });
    expect(binding.threadId).toBe("thread-1");
    expect(binding.cwd).toBe("/tmp/workspace-a");
    fixture.db.close();
  });

  test("bind-current rejects ambiguous recent desktop threads", () => {
    const fixture = createLocatorFixture();
    fixture.addThread({
      id: "thread-1",
      cwd: "/tmp/workspace-a",
      updatedAt: 1000,
      title: "A",
    });
    fixture.addThread({
      id: "thread-2",
      cwd: "/tmp/workspace-b",
      updatedAt: 950,
      title: "B",
    });

    expect(() => fixture.locator.bindCurrent()).toThrow("bind-current is ambiguous");
    fixture.db.close();
  });

  test("findById resolves spawned subagent threads back to the parent desktop thread", () => {
    const fixture = createLocatorFixture();
    fixture.addThread({
      id: "parent-thread",
      cwd: "/tmp/workspace-a",
      updatedAt: 1000,
      title: "Parent",
      source: "vscode",
    });
    fixture.addThread({
      id: "child-thread",
      cwd: "/tmp/workspace-a",
      updatedAt: 1001,
      title: "Child",
      source: JSON.stringify({
        subagent: {
          thread_spawn: {
            parent_thread_id: "parent-thread",
            depth: 1,
          },
        },
      }),
    });

    const binding = fixture.locator.findById("child-thread");
    expect(binding?.threadId).toBe("parent-thread");
    expect(binding?.source).toBe("vscode");
    fixture.db.close();
  });
});
