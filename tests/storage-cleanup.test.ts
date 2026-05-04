import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "vitest";

import { cleanupEmptyTimeoutCallArtifacts, cleanupStorageRoots, rotatePersistentLogFile } from "../src/core/util/storage-cleanup.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "telegram-codex-bridge-storage-cleanup-"));
  tempRoots.push(root);
  return root;
}

function touchOld(path: string, ageDays: number): void {
  const date = new Date(Date.now() - (ageDays * 24 * 60 * 60 * 1000));
  utimesSync(path, date, date);
}

describe("cleanupStorageRoots", () => {
  test("removes stale files and stale empty call directories but keeps roots and recent files", async () => {
    const root = makeRoot();
    const artifactsRoot = join(root, "artifacts");
    const callsRoot = join(root, "calls");
    mkdirSync(artifactsRoot, { recursive: true });
    mkdirSync(callsRoot, { recursive: true });

    const staleArtifact = join(artifactsRoot, "stale.wav");
    const recentArtifact = join(artifactsRoot, "recent.wav");
    writeFileSync(staleArtifact, "old");
    writeFileSync(recentArtifact, "new");
    touchOld(staleArtifact, 30);

    const staleCallDir = join(callsRoot, "old-call");
    mkdirSync(staleCallDir, { recursive: true });
    const staleCallFile = join(staleCallDir, "handoff.md");
    writeFileSync(staleCallFile, "old handoff");
    touchOld(staleCallFile, 30);
    touchOld(staleCallDir, 30);

    const recentCallDir = join(callsRoot, "recent-call");
    mkdirSync(recentCallDir, { recursive: true });
    const recentCallFile = join(recentCallDir, "handoff.md");
    writeFileSync(recentCallFile, "recent handoff");

    const cutoffMs = Date.now() - (14 * 24 * 60 * 60 * 1000);
    const stats = await cleanupStorageRoots([artifactsRoot, callsRoot], cutoffMs);

    expect(stats.removedFiles).toBeGreaterThanOrEqual(2);
    expect(stats.removedDirs).toBeGreaterThanOrEqual(1);
    expect(() => statSync(artifactsRoot)).not.toThrow();
    expect(() => statSync(callsRoot)).not.toThrow();
    expect(() => statSync(staleArtifact)).toThrow();
    expect(readFileSync(recentArtifact, "utf8")).toBe("new");
    expect(() => statSync(staleCallDir)).toThrow();
    expect(readFileSync(recentCallFile, "utf8")).toBe("recent handoff");
  });
});

describe("cleanupEmptyTimeoutCallArtifacts", () => {
  test("removes stale timeout call directories that have no usable transcript", async () => {
    const root = makeRoot();
    const callsRoot = join(root, "calls");
    mkdirSync(callsRoot, { recursive: true });

    const staleTimeoutCall = join(callsRoot, "timeout-call");
    mkdirSync(staleTimeoutCall, { recursive: true });
    writeFileSync(join(staleTimeoutCall, "state.json"), JSON.stringify({
      status: "ended",
      endedReason: "call_start_timeout",
    }));
    writeFileSync(join(staleTimeoutCall, "transcript.md"), "# Call timeout-call\n");
    touchOld(join(staleTimeoutCall, "state.json"), 2);
    touchOld(join(staleTimeoutCall, "transcript.md"), 2);
    touchOld(staleTimeoutCall, 2);

    const usefulTimeoutCall = join(callsRoot, "useful-timeout-call");
    mkdirSync(usefulTimeoutCall, { recursive: true });
    writeFileSync(join(usefulTimeoutCall, "state.json"), JSON.stringify({
      status: "ended",
      endedReason: "call_launch_timeout",
    }));
    writeFileSync(join(usefulTimeoutCall, "transcript.md"), [
      "# Call useful-timeout-call",
      "",
      "## User (2026-04-05T00:00:00.000Z)",
      "",
      "Hello from the call",
      "",
    ].join("\n"));
    touchOld(join(usefulTimeoutCall, "state.json"), 2);
    touchOld(join(usefulTimeoutCall, "transcript.md"), 2);
    touchOld(usefulTimeoutCall, 2);

    const cutoffMs = Date.now() - (60 * 60 * 1000);
    const stats = await cleanupEmptyTimeoutCallArtifacts(callsRoot, cutoffMs);

    expect(stats.removedDirs).toBe(1);
    expect(() => statSync(staleTimeoutCall)).toThrow();
    expect(() => statSync(usefulTimeoutCall)).not.toThrow();
  });

  test("preserves the persisted active call directory during timeout cleanup", async () => {
    const root = makeRoot();
    const callsRoot = join(root, "calls");
    mkdirSync(callsRoot, { recursive: true });

    const activeCall = join(callsRoot, "active-call");
    mkdirSync(activeCall, { recursive: true });
    writeFileSync(join(activeCall, "state.json"), JSON.stringify({
      status: "ended",
      endedReason: "call_start_timeout",
    }));
    writeFileSync(join(activeCall, "transcript.md"), "# Call active-call\n");
    touchOld(join(activeCall, "state.json"), 2);
    touchOld(join(activeCall, "transcript.md"), 2);
    touchOld(activeCall, 2);

    const cutoffMs = Date.now() - (60 * 60 * 1000);
    const stats = await cleanupEmptyTimeoutCallArtifacts(callsRoot, cutoffMs, {
      preserveCallIds: ["active-call"],
    });

    expect(stats.removedDirs).toBe(0);
    expect(() => statSync(activeCall)).not.toThrow();
  });
});

describe("rotatePersistentLogFile", () => {
  test("archives oversized persistent logs before reuse", async () => {
    const root = makeRoot();
    const logPath = join(root, "telegram-daemon.log");
    writeFileSync(logPath, "1234567890", "utf8");

    const rotated = await rotatePersistentLogFile(logPath, {
      maxBytes: 5,
      now: Date.parse("2026-04-09T01:02:03.456Z"),
    });

    expect(rotated?.bytes).toBe(10);
    expect(() => statSync(logPath)).toThrow();
    expect(rotated?.archivedPath.endsWith("/log-archive/2026-04-09T01-02-03-456Z/telegram-daemon.log")).toBe(true);
    expect(readFileSync(rotated!.archivedPath, "utf8")).toBe("1234567890");
  });

  test("leaves small logs in place", async () => {
    const root = makeRoot();
    const logPath = join(root, "telegram-daemon.log");
    writeFileSync(logPath, "1234", "utf8");

    const rotated = await rotatePersistentLogFile(logPath, { maxBytes: 5 });

    expect(rotated).toBeNull();
    expect(readFileSync(logPath, "utf8")).toBe("1234");
  });
});
