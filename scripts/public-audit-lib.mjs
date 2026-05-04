import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".bridge-data", "coverage"]);
const BINARY_ASSET_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".woff",
  ".woff2",
  ".mp3",
  ".wav",
  ".ogg",
  ".zip",
  ".mov",
  ".mp4",
]);
const BINARY_ASSET_ALLOWLIST = new Set([
  "assets/banner.jpg",
  "assets/bridge-workflow-infographic.png",
  "assets/code-from-anywhere-poster.png",
  "assets/social-preview.jpg",
]);
const ALLOWED_URL_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  "openai.com",
  "api.openai.com",
  "platform.openai.com",
  "api.elevenlabs.io",
  "ai.google.dev",
  "developers.google.com",
  "api.telegram.org",
  "core.telegram.org",
  "telegram.org",
  "t.me",
  "github.com",
  "img.shields.io",
  "api.star-history.com",
  "www.star-history.com",
  "llmstxt.org",
  "keepachangelog.com",
  "registry.npmjs.org",
  "semver.org",
  "opencollective.com",
  "www.patreon.com",
  "feross.org",
  "dotenvx.com",
  "tidelift.com",
]);
const PACKAGE_LOCK_URL_ALLOWLIST = new Set([
  ["https://", "paypal.me", "/jimmywarting"].join(""),
]);

const bannedPatterns = [
  {
    label: "legacy private brand",
    pattern: new RegExp(["hype", "rion"].join(""), "gi"),
  },
  {
    label: "private machine username",
    pattern: new RegExp(["jacob", "vogan"].join(""), "gi"),
  },
  {
    label: "private provider env var",
    pattern: new RegExp(["VA", "LAR", "_BASE_URL"].join(""), "g"),
  },
  {
    label: "private absolute path",
    pattern: /(?:^|[\s"'`])(?:\/Users\/|\/home\/)[^/\s"'`]+/gm,
  },
  {
    label: "sample personal name fixture",
    pattern: new RegExp(["\\b(?:Ja", "cob|Mall", "ory)\\b"].join(""), "g"),
  },
  {
    label: "telegram handle-like token",
    pattern: /(?:^|[\s(])@[A-Za-z0-9_]{5,}(?=[\s),.!?:;]|$)/gm,
    // CODEOWNERS intentionally lists GitHub handles as reviewer assignments;
    // those are not Telegram IDs and should not be flagged.
    skipRelPaths: new Set(["CODEOWNERS"]),
  },
];

const runtimeArtifacts = [
  ".env",
  ".env.local",
  "bridge.config.toml",
  ".bridge-data",
  "dist",
  "node_modules",
];

function isIgnoredByGit(repoRoot, path) {
  try {
    execFileSync("git", ["check-ignore", "-q", path], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function isProbablyBinary(buffer) {
  return buffer.includes(0);
}

function isAllowedHost(hostname) {
  const host = hostname.toLowerCase();
  return ALLOWED_URL_HOSTS.has(host)
    || host === "trycloudflare.com"
    || host.endsWith(".trycloudflare.com")
    || host === "example.com"
    || host === "example.org"
    || host === "example.net"
    || host === "example.test"
    || host === "example.invalid"
    || host.startsWith("example.")
    || host.endsWith(".example.com");
}

function checkUrls(text, relPath, failures) {
  const matches = text.match(/\b(?:https?|wss?):\/\/[^\s<>"'`]+/g) ?? [];
  for (const rawUrl of matches) {
    if (rawUrl.includes("${") || rawUrl.includes("*")) {
      continue;
    }
    try {
      const url = new URL(rawUrl);
      if (relPath === "package-lock.json" && PACKAGE_LOCK_URL_ALLOWLIST.has(url.href)) {
        continue;
      }
      if (!isAllowedHost(url.hostname)) {
        failures.add(`${relPath}: found unallowlisted URL host ${url.hostname}`);
      }
    } catch {
      failures.add(`${relPath}: found malformed URL ${rawUrl}`);
    }
  }
}

function suspiciousResidueLabel(relPath) {
  const name = basename(relPath);
  if (/^\.env$/i.test(name)) {
    return "found local env file";
  }
  if (/^\.env\.(?!example$)[^/]+$/i.test(name)) {
    return "found non-example local env file";
  }
  if (/^bridge\.config\.toml$/i.test(name)) {
    return "found local bridge config file";
  }
  if (/^bridge\.config\.(?!example\.toml$).+\.toml$/i.test(name)) {
    return "found non-example bridge config file";
  }
  if (/\.sqlite(?:-(?:wal|shm))?$/i.test(name)) {
    return "found local sqlite state file";
  }
  if (/\.pid$/i.test(name)) {
    return "found local pid file";
  }
  if (/^(?:telegram-daemon|realtime-gateway|media-mcp|bridgectl)\.log$/i.test(name)) {
    return "found local daemon log file";
  }
  if (/^\.bridge-data(?:[-._].+)?$/i.test(name)) {
    return "found bridge data directory or variant outside ignored paths";
  }
  return null;
}

function walk(repoRoot, dir, failures) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) {
      continue;
    }
    const fullPath = join(dir, entry);
    const relPath = relative(repoRoot, fullPath);
    if (relPath && isIgnoredByGit(repoRoot, relPath)) {
      continue;
    }
    const residueLabel = suspiciousResidueLabel(relPath);
    if (residueLabel) {
      failures.add(`${relPath}: ${residueLabel}`);
    }
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walk(repoRoot, fullPath, failures);
      continue;
    }
    const extension = extname(fullPath).toLowerCase();
    const buffer = readFileSync(fullPath);
    if (BINARY_ASSET_EXTENSIONS.has(extension) || isProbablyBinary(buffer)) {
      if (!BINARY_ASSET_ALLOWLIST.has(relPath)) {
        failures.add(`${relPath}: found unallowlisted binary asset`);
      }
      continue;
    }
    const text = buffer.toString("utf8");
    for (const { label, pattern, skipRelPaths } of bannedPatterns) {
      if (skipRelPaths && skipRelPaths.has(relPath)) {
        continue;
      }
      const matches = [...text.matchAll(pattern)];
      if (matches.length > 0) {
        failures.add(`${relPath}: found ${label}`);
      }
    }
    checkUrls(text, relPath, failures);
  }
}

export function auditPublicRepo(repoRoot) {
  const failures = new Set();

  for (const artifact of runtimeArtifacts) {
    const fullPath = join(repoRoot, artifact);
    if (!existsSync(fullPath)) {
      continue;
    }
    if (!isIgnoredByGit(repoRoot, artifact)) {
      failures.add(`${artifact}: local runtime artifact exists and is not git-ignored`);
    }
  }

  walk(repoRoot, repoRoot, failures);
  return [...failures].sort();
}
