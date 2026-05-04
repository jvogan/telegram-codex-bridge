#!/usr/bin/env node
import { readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDir, "..");

const SOURCE_PATHS = [
  "src",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.build.json",
];

const DIST_PATHS = [
  "dist/bin/bridgectl.js",
  "dist/bin/telegram-daemon.js",
  "dist/bin/media-mcp.js",
  "dist/bin/realtime-gateway.js",
  "dist/bin/telegram-configure.js",
  "dist/bin/telegram-discover.js",
];

function newestMtimeMs(path) {
  let details;
  try {
    details = statSync(path);
  } catch {
    return null;
  }
  if (details.isFile()) {
    return details.mtimeMs;
  }
  if (!details.isDirectory()) {
    return null;
  }
  let newest = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".bridge-data") {
      continue;
    }
    const childNewest = newestMtimeMs(join(path, entry.name));
    if (typeof childNewest === "number" && childNewest > newest) {
      newest = childNewest;
    }
  }
  return newest;
}

export function buildFreshness(repoRoot = defaultRepoRoot) {
  const sourceMtims = SOURCE_PATHS
    .map(path => newestMtimeMs(resolve(repoRoot, path)))
    .filter(value => typeof value === "number");
  const sourceNewestAt = sourceMtims.length > 0 ? Math.max(...sourceMtims) : 0;
  const distMtims = DIST_PATHS.map(path => ({
    path,
    mtimeMs: newestMtimeMs(resolve(repoRoot, path)),
  }));
  const missingDist = distMtims.filter(entry => typeof entry.mtimeMs !== "number").map(entry => entry.path);
  const distOldestAt = missingDist.length === 0
    ? Math.min(...distMtims.map(entry => entry.mtimeMs))
    : 0;
  return {
    sourceNewestAt,
    distOldestAt,
    missingDist,
    stale: missingDist.length > 0 || sourceNewestAt > distOldestAt + 1000,
  };
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function ensureBuilt(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? defaultRepoRoot);
  const freshness = buildFreshness(repoRoot);
  if (!freshness.stale) {
    if (!options.quiet) {
      console.log("dist is fresh");
    }
    return freshness;
  }
  if (options.check) {
    throw new Error(
      freshness.missingDist.length > 0
        ? `dist is missing built files: ${freshness.missingDist.join(", ")}`
        : "dist is older than source files",
    );
  }
  if (!options.quiet) {
    console.log("dist is stale; running npm run build");
  }
  const result = spawnSync(npmCommand(), ["run", "build", "--silent"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: options.quiet ? "pipe" : "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || `npm run build exited with status ${result.status}`);
  }
  return buildFreshness(repoRoot);
}

function isMain() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMain()) {
  const args = new Set(process.argv.slice(2));
  try {
    ensureBuilt({
      check: args.has("--check"),
      quiet: args.has("--quiet"),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
