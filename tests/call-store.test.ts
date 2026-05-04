import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, describe, expect, test } from "vitest";

import type { BridgeConfig, BridgeEnv } from "../src/core/config.js";
import { CallStore, ClosedCallMutationError } from "../src/core/realtime/calls.js";
import { BridgeState } from "../src/core/state.js";
import { createTestBridgeConfig, createTestBridgeEnv } from "./helpers/test-config.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function createConfig(root: string, options: { demoPracticeMode?: boolean } = {}): BridgeConfig {
  return createTestBridgeConfig(root, {
    presentation: {
      demo_practice_mode: options.demoPracticeMode ?? false,
    },
  });
}

function createStore(options: { demoPracticeMode?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "telegram-codex-bridge-call-store-"));
  tempRoots.push(root);
  const config = createConfig(root, options);
  const env: BridgeEnv = createTestBridgeEnv();
  const state = new BridgeState(config.storageRoot);
  const store = new CallStore(config, env, state);
  return { root, store, state };
}

describe("CallStore", () => {
  test("marks the call ended in state before summarization resolves", async () => {
    const { store, state } = createStore();
    const call = await store.create({
      callId: "call-1",
      bridgeId: "bridge",
      boundThreadId: "thread-1",
      cwd: "/tmp/workspace",
      contextPack: null,
    });

    let resolveSummary: ((value: {
      summary: string;
      decisions: string[];
      action_items: string[];
      open_questions: string[];
      important_facts: string[];
    }) => void) | null = null;
    const summaryPromise = new Promise<{
      summary: string;
      decisions: string[];
      action_items: string[];
      open_questions: string[];
      important_facts: string[];
    }>(resolve => {
      resolveSummary = resolve;
    });
    (store as any).summarizer = {
      summarize: () => summaryPromise,
    };

    const finalizePromise = store.finalize(call, { reason: "user_hangup", endedAt: call.startedAt + 1_000 });
    for (let index = 0; index < 10 && state.getActiveCall()?.status !== "ended"; index += 1) {
      await sleep(5);
    }

    try {
      expect(state.getActiveCall()?.status).toBe("ended");
    } finally {
      resolveSummary!({
        summary: "done",
        decisions: [],
        action_items: [],
        open_questions: [],
        important_facts: [],
      });
      const finalized = await finalizePromise;
      expect(finalized.call.status).toBe("ended");
    }
  });

  test("backfills transcript state from gateway events before finalizing", async () => {
    const { store, state } = createStore();
    const call = await store.create({
      callId: "call-2",
      bridgeId: "bridge",
      boundThreadId: "thread-2",
      cwd: "/tmp/workspace",
      contextPack: null,
    });

    const gatewayPath = join(join((store as any).callsRoot, call.callId), "gateway-events.ndjson");
    writeFileSync(
      gatewayPath,
      [
        JSON.stringify({ at: "2026-04-05T00:00:00.000Z", event: { type: "call.started", at: 1 } }),
        JSON.stringify({ at: "2026-04-05T00:00:01.000Z", event: { type: "user.transcript.final", at: 2, text: "hello from the call" } }),
        JSON.stringify({ at: "2026-04-05T00:00:02.000Z", event: { type: "assistant.transcript.final", at: 3, text: "acknowledged" } }),
      ].join("\n") + "\n",
    );

    (store as any).summarizer = {
      summarize: async ({ transcript }: { transcript: string }) => ({
        summary: transcript.includes("hello from the call") ? "captured transcript" : "missing transcript",
        decisions: [],
        action_items: [],
        open_questions: [],
        important_facts: [],
      }),
    };

    const finalized = await store.finalize(call, { reason: "user_hangup", endedAt: call.startedAt + 1_000 });

    expect(readFileSync(call.transcriptPath, "utf8")).toContain("hello from the call");
    expect(readFileSync(call.transcriptPath, "utf8")).toContain("acknowledged");
    expect(readFileSync(call.eventPath, "utf8")).toContain("\"user.transcript.final\"");
    expect(finalized.artifact.summary).toBe("captured transcript");
    expect(state.getActiveCall()?.status).toBe("ended");
  });

  test("late call events do not resurrect a cleared active call", async () => {
    const { store, state } = createStore();
    const call = await store.create({
      callId: "call-3",
      bridgeId: "bridge",
      boundThreadId: "thread-3",
      cwd: "/tmp/workspace",
      contextPack: null,
    });

    const { call: endedCall } = await store.finalize(call, { reason: "user_hangup", endedAt: call.startedAt + 1_000 });
    store.clearActiveCall(call.callId);
    expect(state.getActiveCall()).toBeNull();

    await store.appendEvent(endedCall, {
      type: "call.ended",
      at: call.startedAt + 2_000,
      reason: "browser_disconnect",
    });

    expect(state.getActiveCall()).toBeNull();
  });

  test("merges staged inbox rows into the finalized artifact even if they were not yet written to the persisted ledger", async () => {
    const { store, state } = createStore();
    const call = await store.create({
      callId: "call-4",
      bridgeId: "bridge",
      boundThreadId: "thread-4",
      cwd: "/tmp/workspace",
      contextPack: null,
    });

    state.enqueueCallInboxItem({
      id: "call-item-1",
      callId: call.callId,
      updateId: 1,
      chatId: "123",
      messageId: 1,
      kind: "document",
      text: "Reference this PDF",
      documentFileName: "notes.pdf",
      documentPath: "/tmp/notes.pdf",
      status: "staged",
      createdAt: Date.now(),
    });

    (store as any).summarizer = {
      summarize: async () => ({
        summary: "included staged inbox rows",
        decisions: [],
        action_items: [],
        open_questions: [],
        important_facts: [],
      }),
    };

    const finalized = await store.finalize(call, { reason: "user_hangup", endedAt: call.startedAt + 1_000 });

    expect(finalized.artifact.attachments).toEqual([
      expect.objectContaining({
        id: "call-item-1",
        kind: "document",
        path: "/tmp/notes.pdf",
      }),
    ]);
  });

  test("hides absolute local paths in markdown handoffs when demo practice mode is enabled", async () => {
    const { root, store, state } = createStore({ demoPracticeMode: true });
    const call = await store.create({
      callId: "call-5",
      bridgeId: "bridge",
      boundThreadId: "thread-5",
      cwd: join(root, "workspace"),
      contextPack: null,
    });
    const documentPath = join(root, "uploads", "notes.pdf");
    const transcriptPath = join(root, "uploads", "notes.txt");

    state.enqueueCallInboxItem({
      id: "call-item-2",
      callId: call.callId,
      updateId: 2,
      chatId: "123",
      messageId: 2,
      kind: "document",
      text: "Reference this PDF",
      documentFileName: "notes.pdf",
      documentPath,
      transcriptPath,
      status: "staged",
      createdAt: Date.now(),
    });

    (store as any).summarizer = {
      summarize: async () => ({
        summary: "demo handoff",
        decisions: [],
        action_items: [],
        open_questions: [],
        important_facts: [],
      }),
    };

    const finalized = await store.finalize(call, { reason: "user_hangup", endedAt: call.startedAt + 1_000 });
    const markdown = readFileSync(finalized.call.handoffMarkdownPath, "utf8");

    expect(finalized.artifact.cwd).toBe(join(root, "workspace"));
    expect(finalized.artifact.attachments).toEqual([
      expect.objectContaining({
        path: documentPath,
        transcriptPath,
      }),
    ]);
    expect(markdown).toContain("- CWD: workspace");
    expect(markdown).toContain("- Transcript: transcript.md");
    expect(markdown).toContain("path=notes.pdf");
    expect(markdown).toContain("transcript=notes.txt");
    expect(markdown).not.toContain(root);
  });

  test("rejects late inbox attachments after the call has already ended", async () => {
    const { store } = createStore();
    const call = await store.create({
      callId: "call-6",
      bridgeId: "bridge",
      boundThreadId: "thread-6",
      cwd: "/tmp/workspace",
      contextPack: null,
    });

    const { call: endedCall } = await store.finalize(call, { reason: "user_hangup", endedAt: call.startedAt + 1_000 });

    await expect(store.attachInboxItem(endedCall, {
      id: "late-item",
      callId: endedCall.callId,
      updateId: 2,
      chatId: "123",
      messageId: 2,
      kind: "text",
      text: "too late",
      status: "queued",
      createdAt: Date.now(),
    })).rejects.toBeInstanceOf(ClosedCallMutationError);
  });
});
