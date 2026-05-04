import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "vitest";

import { buildCallContextPack, buildRealtimeInstructions } from "../src/core/realtime/context.js";
import { BridgeState } from "../src/core/state.js";
import type { BoundThread, QueuedTelegramTask } from "../src/core/types.js";
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

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "telegram-codex-bridge-realtime-context-"));
  tempRoots.push(root);
  return root;
}

describe("buildCallContextPack", () => {
  test("collects recent turns and queued tasks from the bound thread", async () => {
    const root = createRoot();
    const rolloutPath = join(root, "rollout.jsonl");
    writeFileSync(rolloutPath, [
      JSON.stringify({
        timestamp: "2026-04-04T00:00:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Can you connect to Telegram for me?" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-04T00:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Yes. I can bind the bridge to this thread." }],
        },
      }),
    ].join("\n"));
    const state = new BridgeState(root);
    const pendingTask: QueuedTelegramTask = {
      id: "task-1",
      updateId: 1,
      chatId: "123",
      messageId: 9,
      kind: "text",
      text: "reply on Telegram later",
      createdAt: Date.now(),
    };
    state.enqueueTask(pendingTask);
    const boundThread: BoundThread = {
      threadId: "thread-1",
      cwd: "/tmp/workspace",
      rolloutPath,
      source: "vscode",
      boundAt: Date.now(),
    };

    const contextPack = await buildCallContextPack({
      callId: "call-1",
      boundThread,
      mode: "shared-thread-resume",
      owner: "telegram",
      state,
    });

    expect(contextPack.recentTurns).toEqual([
      {
        role: "user",
        text: "Can you connect to Telegram for me?",
        timestamp: "2026-04-04T00:00:00.000Z",
        source: "thread",
      },
      {
        role: "assistant",
        text: "Yes. I can bind the bridge to this thread.",
        timestamp: "2026-04-04T00:00:01.000Z",
        source: "thread",
      },
    ]);
    expect(contextPack.queuedItems).toEqual(["text: reply on Telegram later"]);
    expect(buildRealtimeInstructions(createTestBridgeConfig(root), contextPack)).toContain("Current goals:");
  });

  test("reads recent rollout context from the tail of large rollout files", async () => {
    const root = createRoot();
    const rolloutPath = join(root, "rollout-large.jsonl");
    const filler = Array.from({ length: 6_000 }, (_, index) => JSON.stringify({
      timestamp: `2026-04-04T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: `filler ${index}` }],
      },
    })).join("\n");
    writeFileSync(rolloutPath, [
      filler,
      JSON.stringify({
        timestamp: "2026-04-04T00:10:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Keep the recent turn near the end." }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-04T00:10:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Recent answer from the end of the rollout." }],
        },
      }),
    ].join("\n"));
    const state = new BridgeState(root);

    const contextPack = await buildCallContextPack({
      callId: "call-tail",
      boundThread: {
        threadId: "thread-tail",
        cwd: "/tmp/workspace",
        rolloutPath,
        source: "desktop",
        boundAt: Date.now(),
      },
      mode: "shared-thread-resume",
      owner: "telegram",
      state,
    });

    expect(contextPack.recentTurns.at(-2)?.text).toBe("Keep the recent turn near the end.");
    expect(contextPack.recentTurns.at(-1)?.text).toBe("Recent answer from the end of the rollout.");
  });

  test("filters commentary noise and turn-aborted markers from live-call context", async () => {
    const root = createRoot();
    const rolloutPath = join(root, "rollout-noise.jsonl");
    writeFileSync(rolloutPath, [
      JSON.stringify({
        timestamp: "2026-04-04T00:00:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<turn_aborted>\ninterrupted\n</turn_aborted>" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-04T00:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "I am checking the bridge status now." }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-04T00:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Call me on Telegram." }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-04T00:00:03.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "I will arm the bridge and send the invite." }],
        },
      }),
    ].join("\n"));
    const state = new BridgeState(root);

    const contextPack = await buildCallContextPack({
      callId: "call-clean",
      boundThread: {
        threadId: "thread-clean",
        cwd: "/tmp/workspace",
        rolloutPath,
        source: "desktop",
        boundAt: Date.now(),
      },
      mode: "shared-thread-resume",
      owner: "telegram",
      state,
    });

    expect(contextPack.recentTurns).toEqual([
      {
        role: "user",
        text: "Call me on Telegram.",
        timestamp: "2026-04-04T00:00:02.000Z",
        source: "thread",
      },
      {
        role: "assistant",
        text: "I will arm the bridge and send the invite.",
        timestamp: "2026-04-04T00:00:03.000Z",
        source: "thread",
      },
    ]);
    const instructions = buildRealtimeInstructions(createTestBridgeConfig(root), contextPack);
    expect(instructions).toContain("This call is only between you and the Telegram user who opened the Mini App.");
    expect(instructions).toContain("Do not claim that you can place phone calls to third parties");
  });
});
