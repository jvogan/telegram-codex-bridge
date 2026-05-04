import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { auditPublicRepo } from "./public-audit-lib.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const failures = auditPublicRepo(repoRoot);

if (failures.length > 0) {
  console.error("Public audit failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Public audit passed.");
