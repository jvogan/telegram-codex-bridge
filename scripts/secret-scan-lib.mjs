import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".bridge-data", "coverage"]);
const BINARY_EXTENSIONS = new Set([
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

const SECRET_PATTERNS = [
  { label: "OpenAI-style secret", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { label: "Telegram bot token", pattern: /\b\d{7,11}:[A-Za-z0-9_-]{20,}\b/g },
  { label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { label: "Private key block", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
];

const ALLOWLIST_PATH_PATTERNS = [];

const ALLOWLIST_SNIPPETS = new Set([
  "sk-example-not-a-real-secret-value",
  "000000000:TEST_TOKEN_FOR_DOCS_ONLY",
  "AIzaExampleKeyNotARealSecretValue0000000",
  "ghp_exampletokennotrealsecretvalue0000",
]);

function normalizePath(path) {
  return path.split(sep).join("/");
}

function hasGitMetadata(repoRoot) {
  return existsSync(join(repoRoot, ".git"));
}

function loadGitignorePatterns(repoRoot) {
  const gitignorePath = join(repoRoot, ".gitignore");
  if (!existsSync(gitignorePath)) {
    return [];
  }
  return readFileSync(gitignorePath, "utf8")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#") && !line.startsWith("!"));
}

function globToRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regexBody = escaped
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${regexBody}$`);
}

function matchesIgnorePattern(relPath, pattern) {
  const normalizedPath = normalizePath(relPath);
  const basename = normalizedPath.split("/").pop() ?? normalizedPath;
  let candidate = pattern.trim();
  if (!candidate) {
    return false;
  }
  if (candidate.startsWith("/")) {
    candidate = candidate.slice(1);
  }
  const directoryOnly = candidate.endsWith("/");
  if (directoryOnly) {
    candidate = candidate.slice(0, -1);
  }
  const hasSlash = candidate.includes("/");
  const target = hasSlash ? normalizedPath : basename;

  if (candidate.includes("*") || candidate.includes("?")) {
    const regex = globToRegex(candidate);
    return regex.test(target) || (!hasSlash && regex.test(normalizedPath));
  }

  if (hasSlash) {
    return normalizedPath === candidate || normalizedPath.startsWith(`${candidate}/`);
  }
  if (basename === candidate || normalizedPath === candidate) {
    return true;
  }
  if (directoryOnly) {
    return normalizedPath.startsWith(`${candidate}/`) || normalizedPath.includes(`/${candidate}/`);
  }
  return normalizedPath.startsWith(`${candidate}/`);
}

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

function isIgnoredPath(repoRoot, relPath, ignorePatterns) {
  if (!relPath) {
    return false;
  }
  if (hasGitMetadata(repoRoot)) {
    return isIgnoredByGit(repoRoot, relPath);
  }
  return ignorePatterns.some(pattern => matchesIgnorePattern(relPath, pattern));
}

function isProbablyBinary(buffer) {
  return buffer.includes(0);
}

export function isAllowlistedSecretMatch(relPath, matchText) {
  return ALLOWLIST_PATH_PATTERNS.some(pattern => pattern.test(relPath))
    || ALLOWLIST_SNIPPETS.has(matchText)
    || /(?:example|placeholder|not-a-real-secret|docs-only|test[_-]?token)/i.test(matchText);
}

function walk(repoRoot, dir, failures, ignorePatterns) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) {
      continue;
    }
    const fullPath = join(dir, entry);
    const relPath = relative(repoRoot, fullPath);
    if (relPath && isIgnoredPath(repoRoot, relPath, ignorePatterns)) {
      continue;
    }
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walk(repoRoot, fullPath, failures, ignorePatterns);
      continue;
    }
    const extension = extname(fullPath).toLowerCase();
    const buffer = readFileSync(fullPath);
    if (BINARY_EXTENSIONS.has(extension) || isProbablyBinary(buffer)) {
      continue;
    }
    const text = buffer.toString("utf8");
    for (const { label, pattern } of SECRET_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const matchText = match[0];
        if (!matchText || isAllowlistedSecretMatch(relPath, matchText)) {
          continue;
        }
        failures.add(`${normalizePath(relPath)}: found ${label}`);
      }
    }
  }
}

export function scanRepoForSecrets(repoRoot) {
  const failures = new Set();
  const ignorePatterns = loadGitignorePatterns(repoRoot);
  walk(repoRoot, repoRoot, failures, ignorePatterns);
  return [...failures].sort();
}
