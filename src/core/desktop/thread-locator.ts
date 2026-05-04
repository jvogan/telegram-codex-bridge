import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { BoundThread } from "../types.js";

interface ThreadRow {
  id: string;
  rollout_path: string;
  created_at: number;
  updated_at: number;
  source: string;
  cwd: string;
  title: string;
  archived: number;
}

function parseParentThreadId(source: string): string | null {
  if (source === "vscode") {
    return null;
  }
  try {
    const parsed = JSON.parse(source) as {
      subagent?: {
        thread_spawn?: {
          parent_thread_id?: string;
        };
      };
    };
    return parsed.subagent?.thread_spawn?.parent_thread_id ?? null;
  } catch {
    return null;
  }
}

export class DesktopThreadLocator {
  readonly stateDbPath: string;

  constructor(stateDbPath = join(homedir(), ".codex", "state_5.sqlite")) {
    this.stateDbPath = stateDbPath;
  }

  private openDb(): DatabaseSync {
    if (!existsSync(this.stateDbPath)) {
      throw new Error(`Codex desktop state database not found at ${this.stateDbPath}`);
    }
    return new DatabaseSync(this.stateDbPath, { readOnly: true });
  }

  listRecentDesktopThreads(limit = 10): BoundThread[] {
    const db = this.openDb();
    try {
      const rows = db.prepare(`
        SELECT id, rollout_path, created_at, updated_at, source, cwd, title, archived
        FROM threads
        WHERE archived = 0 AND source = 'vscode'
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(limit) as unknown as ThreadRow[];
      return rows
        .filter(row => existsSync(row.rollout_path))
        .map(row => ({
          threadId: row.id,
          cwd: row.cwd,
          rolloutPath: row.rollout_path,
          source: row.source,
          title: row.title,
          updatedAt: row.updated_at,
          boundAt: Date.now(),
        }));
    } finally {
      db.close();
    }
  }

  private getRowById(db: DatabaseSync, threadId: string): ThreadRow | null {
    const row = db.prepare(`
      SELECT id, rollout_path, created_at, updated_at, source, cwd, title, archived
      FROM threads
      WHERE id = ?
      LIMIT 1
    `).get(threadId) as unknown as ThreadRow | undefined;
    return row ?? null;
  }

  private resolveBindableRow(db: DatabaseSync, row: ThreadRow | null): ThreadRow | null {
    let current = row;
    const seen = new Set<string>();
    while (current && current.source !== "vscode") {
      if (seen.has(current.id)) {
        return null;
      }
      seen.add(current.id);
      const parentThreadId = parseParentThreadId(current.source);
      if (!parentThreadId) {
        return null;
      }
      current = this.getRowById(db, parentThreadId);
    }
    return current;
  }

  listMatchingDesktopThreads(options?: { cwd?: string; limit?: number }): BoundThread[] {
    const candidates = this.listRecentDesktopThreads(options?.limit ?? 10);
    if (!options?.cwd) {
      return candidates;
    }
    const target = resolve(options.cwd);
    return candidates.filter(candidate => resolve(candidate.cwd) === target);
  }

  findById(threadId: string): BoundThread | null {
    const db = this.openDb();
    try {
      const row = this.resolveBindableRow(db, this.getRowById(db, threadId));
      if (!row || row.archived !== 0 || !existsSync(row.rollout_path)) {
        return null;
      }
      return {
        threadId: row.id,
        cwd: row.cwd,
        rolloutPath: row.rollout_path,
        source: row.source,
        title: row.title,
        updatedAt: row.updated_at,
        boundAt: Date.now(),
      };
    } finally {
      db.close();
    }
  }

  bindCurrent(options?: { cwd?: string; limit?: number; recentWindowSeconds?: number }): BoundThread {
    const candidates = this.listMatchingDesktopThreads({
      ...(options?.cwd ? { cwd: options.cwd } : {}),
      ...(options?.limit !== undefined ? { limit: options.limit } : {}),
    });
    if (candidates.length === 0) {
      throw new Error("No matching Codex desktop thread was found.");
    }
    const recentWindowSeconds = options?.recentWindowSeconds ?? 1800;
    const newest = candidates[0]!;
    const ambiguous = candidates.filter(candidate => {
      if (candidate.updatedAt === undefined || newest.updatedAt === undefined) {
        return true;
      }
      return newest.updatedAt - candidate.updatedAt <= recentWindowSeconds;
    });
    if (ambiguous.length > 1) {
      const rendered = candidates
        .map(candidate => `${candidate.threadId} | ${candidate.cwd} | ${candidate.title ?? "(untitled)"}`)
        .join("\n");
      throw new Error(`bind-current is ambiguous. Use an explicit thread id.\n${rendered}`);
    }
    return newest;
  }
}
