export interface BuildFreshness {
  sourceNewestAt: number;
  distOldestAt: number;
  missingDist: string[];
  stale: boolean;
}

export function buildFreshness(repoRoot?: string): BuildFreshness;
export function ensureBuilt(options?: {
  repoRoot?: string;
  check?: boolean;
  quiet?: boolean;
}): BuildFreshness;
