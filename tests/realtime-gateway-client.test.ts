import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "vitest";

import type { BridgeConfig } from "../src/core/config.js";
import { deriveControlUrl } from "../src/core/realtime/gateway-client.js";
import { createTestBridgeConfig } from "./helpers/test-config.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function createConfig(root: string): BridgeConfig {
  return createTestBridgeConfig(root, {
    realtime: {
      public_url: "https://example.trycloudflare.com",
    },
  });
}

describe("deriveControlUrl", () => {
  test("prefers the local gateway by default even when public_url is set", () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-bridge-gateway-client-"));
    tempRoots.push(root);
    const config = createConfig(root);

    expect(deriveControlUrl(config)).toBe("ws://127.0.0.1:8890/ws/bridge");
  });

  test("uses control_url when explicitly configured", () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-bridge-gateway-client-"));
    tempRoots.push(root);
    const config = createConfig(root);
    config.realtime.control_url = "wss://control.example.com/ws/bridge";

    expect(deriveControlUrl(config)).toBe("wss://control.example.com/ws/bridge");
  });
});
