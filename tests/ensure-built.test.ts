import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { buildFreshness } from "../scripts/ensure-built.mjs";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function createRepoFixture(): string {
  const root = join(tmpdir(), `telegram-codex-ensure-built-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  tempRoots.push(root);
  mkdirSync(join(root, "src", "bin"), { recursive: true });
  mkdirSync(join(root, "dist", "bin"), { recursive: true });
  writeFileSync(join(root, "src", "bin", "bridgectl.ts"), "export {};\n");
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(root, "package-lock.json"), "{}\n");
  writeFileSync(join(root, "tsconfig.json"), "{}\n");
  writeFileSync(join(root, "tsconfig.build.json"), "{}\n");
  for (const fileName of [
    "bridgectl.js",
    "telegram-daemon.js",
    "media-mcp.js",
    "realtime-gateway.js",
    "telegram-configure.js",
    "telegram-discover.js",
  ]) {
    writeFileSync(join(root, "dist", "bin", fileName), "export {};\n");
  }
  return root;
}

function touch(path: string, timestamp: Date): void {
  utimesSync(path, timestamp, timestamp);
}

function touchAllSources(root: string, timestamp: Date): void {
  for (const sourcePath of [
    join(root, "src", "bin", "bridgectl.ts"),
    join(root, "package.json"),
    join(root, "package-lock.json"),
    join(root, "tsconfig.json"),
    join(root, "tsconfig.build.json"),
  ]) {
    touch(sourcePath, timestamp);
  }
}

function touchAllDist(root: string, timestamp: Date): void {
  for (const fileName of [
    "bridgectl.js",
    "telegram-daemon.js",
    "media-mcp.js",
    "realtime-gateway.js",
    "telegram-configure.js",
    "telegram-discover.js",
  ]) {
    touch(join(root, "dist", "bin", fileName), timestamp);
  }
}

describe("ensure-built freshness detection", () => {
  test("reports fresh dist when built files are newer than sources", () => {
    const root = createRepoFixture();
    touchAllSources(root, new Date("2026-01-01T00:00:00Z"));
    touchAllDist(root, new Date("2026-01-01T00:01:00Z"));

    expect(buildFreshness(root).stale).toBe(false);
  });

  test("reports stale dist when source files are newer", () => {
    const root = createRepoFixture();
    touchAllSources(root, new Date("2026-01-01T00:02:00Z"));
    touchAllDist(root, new Date("2026-01-01T00:00:00Z"));

    expect(buildFreshness(root).stale).toBe(true);
  });
});
