import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const apply = process.argv.includes("--apply");

const ROOT_TARGETS = [
  ".env",
  ".env.local",
  "bridge.config.toml",
  ".bridge-data",
  "dist",
  "output",
  "tmp",
];

const SKIP_DIRS = new Set([".git", "node_modules", ".bridge-data", "dist", "output", "tmp"]);

function collectRootTargets() {
  return ROOT_TARGETS
    .map(path => join(repoRoot, path))
    .filter(path => existsSync(path));
}

function collectNestedResidue(dir, results) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) {
      continue;
    }
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      collectNestedResidue(fullPath, results);
      continue;
    }
    if (
      /\.pid$/i.test(entry)
      || /\.sqlite(?:-(?:wal|shm))?$/i.test(entry)
      || /^(?:telegram-daemon|realtime-gateway|media-mcp|bridgectl)\.log$/i.test(entry)
    ) {
      results.push(fullPath);
    }
  }
}

const candidates = [...collectRootTargets()];
collectNestedResidue(repoRoot, candidates);

if (candidates.length === 0) {
  console.log("No local runtime state found.");
  process.exit(0);
}

if (!apply) {
  console.log("Dry run. Local runtime state that can be removed before public publish:");
  for (const path of candidates.sort()) {
    console.log(`- ${relative(repoRoot, path)}`);
  }
  console.log("Re-run with --apply to delete these files and directories.");
  process.exit(0);
}

for (const path of candidates) {
  rmSync(path, { recursive: true, force: true });
}

console.log("Removed local runtime state:");
for (const path of candidates.sort()) {
  console.log(`- ${relative(repoRoot, path)}`);
}
