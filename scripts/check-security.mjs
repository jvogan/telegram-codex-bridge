import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { auditPublicRepo } from "./public-audit-lib.mjs";
import { scanRepoForSecrets } from "./secret-scan-lib.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const args = new Set(process.argv.slice(2));

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function runAudit() {
  if (args.has("--no-audit")) {
    return [];
  }
  const result = spawnSync(
    npmCommand(),
    ["audit", "--omit=dev", "--json"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: process.env,
    },
  );
  if (result.error) {
    return [`npm audit failed to start: ${result.error.message}`];
  }
  const raw = result.stdout || result.stderr;
  if (!raw) {
    return result.status === 0 ? [] : ["npm audit returned no output."];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [`npm audit returned non-JSON output:\n${raw.trim()}`];
  }
  if (parsed.error) {
    return [
      `npm audit failed: ${parsed.error.summary ?? parsed.error.code ?? parsed.error.message ?? "unknown error"}`,
    ];
  }
  const vulnerabilities = parsed.metadata?.vulnerabilities ?? {};
  const total = Number(vulnerabilities.total ?? 0);
  if (result.status !== 0 || total > 0) {
    return [
      `npm audit reported production vulnerabilities: critical=${vulnerabilities.critical ?? 0}, high=${vulnerabilities.high ?? 0}, moderate=${vulnerabilities.moderate ?? 0}, low=${vulnerabilities.low ?? 0}, total=${total}`,
    ];
  }
  return [];
}

const failures = [
  ...runAudit(),
  ...auditPublicRepo(repoRoot),
  ...scanRepoForSecrets(repoRoot),
];

if (failures.length > 0) {
  console.error("Security check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Security check passed.");
