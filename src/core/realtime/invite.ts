import type { BridgeConfig } from "../config.js";
import type { RealtimeCallSurfaceRecord } from "../types.js";
import { buildSurfaceLaunchUrl } from "./surface.js";

export function buildCallLaunchUrl(
  config: BridgeConfig,
  surface: RealtimeCallSurfaceRecord | null,
): string | null {
  if (!surface) {
    return null;
  }
  return buildSurfaceLaunchUrl(config, surface);
}

export function buildCallLaunchMarkup(
  config: BridgeConfig,
  surface: RealtimeCallSurfaceRecord | null,
): Record<string, unknown> | null {
  const url = buildCallLaunchUrl(config, surface);
  if (!url) {
    return null;
  }
  return {
    inline_keyboard: [[{
      text: "Open live call",
      web_app: {
        url,
      },
    }]],
  };
}

export function buildCallInviteText(config: BridgeConfig, note?: string): string {
  const lines = [
    `Open the Mini App to start ${config.branding.realtime_call_title}.`,
    "The call will use the currently bound Codex session as follow-up context.",
  ];
  if (note?.trim()) {
    lines.push("", note.trim());
  }
  return lines.join("\n");
}
