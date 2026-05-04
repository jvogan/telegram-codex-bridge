import { callNeedsFinalization } from "./finalization.js";

import type { ActiveCallRecord, RealtimeCallSurfaceRecord } from "../types.js";

export type StartupCallSurfaceAction =
  | "noop"
  | "preserve_for_finalization"
  | "recover_managed_surface"
  | "disarm_surface"
  | "cleanup_orphaned_tunnel";

export function planStartupCallSurfaceAction(input: {
  activeCall: ActiveCallRecord | null;
  surface: RealtimeCallSurfaceRecord;
  tunnelPresent: boolean;
}): StartupCallSurfaceAction {
  if (callNeedsFinalization(input.activeCall)) {
    return input.surface.armed || input.tunnelPresent ? "preserve_for_finalization" : "noop";
  }
  if (input.surface.armed && input.surface.tunnelMode === "managed-quick-cloudflared") {
    return "recover_managed_surface";
  }
  if (input.surface.armed) {
    return "disarm_surface";
  }
  if (input.tunnelPresent) {
    return "cleanup_orphaned_tunnel";
  }
  return "noop";
}
