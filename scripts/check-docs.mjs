import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

const markdownRoots = [
  "AGENTS.md",
  "CODE_OF_CONDUCT.md",
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "SUPPORT.md",
  "docs",
];

const internalRoutes = new Set([
  "/healthz",
  "/healthz/details",
  "/miniapp",
  "/api/call/bootstrap",
  "/api/call/hangup",
  "/api/call/finalize",
  "/ws/call",
  "/ws/bridge",
]);

const failures = new Set();

function collectMarkdownFiles(path) {
  const fullPath = join(repoRoot, path);
  const stat = statSync(fullPath);
  if (stat.isFile()) {
    return [fullPath];
  }
  const files = [];
  for (const entry of readdirSync(fullPath)) {
    files.push(...collectMarkdownFiles(join(path, entry)));
  }
  return files.filter(file => file.endsWith(".md"));
}

function parseConfigKeys() {
  const configText = readFileSync(join(repoRoot, "bridge.config.example.toml"), "utf8");
  const keys = new Set();
  let currentSection = "";
  for (const rawLine of configText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      continue;
    }
    const keyMatch = line.match(/^([a-z_][a-z0-9_]*)\s*=/);
    if (keyMatch && currentSection) {
      keys.add(`${currentSection}.${keyMatch[1]}`);
    }
  }
  return keys;
}

const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const scriptNames = new Set(Object.keys(packageJson.scripts ?? {}));

const telegramDaemonSource = readFileSync(join(repoRoot, "src/bin/telegram-daemon.ts"), "utf8");
const telegramConfigureSource = readFileSync(join(repoRoot, "src/bin/telegram-configure.ts"), "utf8");
const slashCommands = new Set();

for (const match of telegramDaemonSource.matchAll(/case\s+"(\/[a-z0-9_-]+)"/g)) {
  slashCommands.add(match[1]);
}
for (const match of telegramConfigureSource.matchAll(/command:\s+"([a-z0-9_]+)"/g)) {
  slashCommands.add(`/${match[1]}`);
}

const configKeys = parseConfigKeys();
const topLevelConfigSections = new Set([...configKeys].map(key => key.split(".")[0]));
const markdownFiles = markdownRoots.flatMap(collectMarkdownFiles);

for (const file of markdownFiles) {
  const relPath = file.replace(`${repoRoot}/`, "");
  const text = readFileSync(file, "utf8");

  for (const match of text.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) {
    const scriptName = match[1];
    if (!scriptNames.has(scriptName)) {
      failures.add(`${relPath}: unknown npm script ${scriptName}`);
    }
  }

  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const token = match[1].trim();

    if (/^\/[A-Za-z0-9/_-]+(?:\s+.*)?$/.test(token)) {
      const routeOrCommand = token.split(/\s+/)[0];
      if (!slashCommands.has(routeOrCommand) && !internalRoutes.has(routeOrCommand)) {
        failures.add(`${relPath}: unknown slash command or internal route ${routeOrCommand}`);
      }
      continue;
    }

    if (
      /^[a-z_][a-z0-9_]*(?:\.[a-z0-9_]+)+$/.test(token)
      && !token.endsWith(".md")
      && !token.endsWith(".toml")
      && !token.endsWith(".json")
      && !token.endsWith(".mjs")
      && topLevelConfigSections.has(token.split(".")[0])
    ) {
      if (!configKeys.has(token)) {
        failures.add(`${relPath}: unknown config key ${token}`);
      }
    }
  }
}

if (failures.size > 0) {
  console.error("Docs check failed:");
  for (const failure of [...failures].sort()) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Docs check passed.");
