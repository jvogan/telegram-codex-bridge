import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test, vi } from "vitest";

import { RolloutWatcher } from "../src/core/desktop/rollout-watcher.js";

const tempRoots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function makeRollout(lines: string[]): { path: string; startedAt: number } {
  const root = mkdtempSync(join(tmpdir(), "telegram-codex-bridge-rollout-"));
  tempRoots.push(root);
  const path = join(root, "rollout.jsonl");
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
  return { path, startedAt: Date.parse("2026-04-04T18:00:00.000Z") };
}

describe("RolloutWatcher", () => {
  test("ignores a lone orphaned start after wall-clock stale expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-04T18:00:10.000Z"));
    const { path } = makeRollout([
      JSON.stringify({
        timestamp: "2026-04-04T17:00:00.100Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "orphaned-old-turn" },
      }),
    ]);

    const watcher = new RolloutWatcher();
    await expect(watcher.getThreadActivity(path)).resolves.toEqual({
      activeTurnId: null,
      activeTurnIds: [],
      lastStartedAt: Date.parse("2026-04-04T17:00:00.100Z"),
      lastCompletedAt: null,
    });
  });

  test("reports an open turn when the latest task has started but not completed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-04T18:00:10.000Z"));
    const { path } = makeRollout([
      JSON.stringify({
        timestamp: "2026-04-04T18:00:00.100Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-open" },
      }),
    ]);

    const watcher = new RolloutWatcher();
    await expect(watcher.getThreadActivity(path)).resolves.toEqual({
      activeTurnId: "turn-open",
      activeTurnIds: ["turn-open"],
      lastStartedAt: Date.parse("2026-04-04T18:00:00.100Z"),
      lastCompletedAt: null,
    });
  });

  test("reports the thread idle again after the latest task completes", async () => {
    const { path } = makeRollout([
      JSON.stringify({
        timestamp: "2026-04-04T18:00:00.100Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-closed" },
      }),
      JSON.stringify({
        timestamp: "2026-04-04T18:00:02.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "turn-closed", last_agent_message: "Done" },
      }),
    ]);

    const watcher = new RolloutWatcher();
    await expect(watcher.getThreadActivity(path)).resolves.toEqual({
      activeTurnId: null,
      activeTurnIds: [],
      lastStartedAt: Date.parse("2026-04-04T18:00:00.100Z"),
      lastCompletedAt: Date.parse("2026-04-04T18:00:02.000Z"),
    });
  });

  test("keeps newer overlapping turns active when an older turn completes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-04T18:00:10.000Z"));
    const { path } = makeRollout([
      JSON.stringify({
        timestamp: "2026-04-04T18:00:00.100Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "telegram-turn" },
      }),
      JSON.stringify({
        timestamp: "2026-04-04T18:00:01.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "desktop-turn" },
      }),
      JSON.stringify({
        timestamp: "2026-04-04T18:00:02.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "telegram-turn", last_agent_message: "Done" },
      }),
    ]);

    const watcher = new RolloutWatcher();
    await expect(watcher.getThreadActivity(path)).resolves.toEqual({
      activeTurnId: "desktop-turn",
      activeTurnIds: ["desktop-turn"],
      lastStartedAt: Date.parse("2026-04-04T18:00:01.000Z"),
      lastCompletedAt: Date.parse("2026-04-04T18:00:02.000Z"),
    });
  });

  test("keeps an older active turn fresh when later tool activity references it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-04T18:00:10.000Z"));
    const { path } = makeRollout([
      JSON.stringify({
        timestamp: "2026-04-04T17:00:00.100Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "long-turn" },
      }),
      JSON.stringify({
        timestamp: "2026-04-04T17:59:59.100Z",
        type: "event_msg",
        payload: { type: "exec_command_end", turn_id: "long-turn" },
      }),
      JSON.stringify({
        timestamp: "2026-04-04T18:00:00.100Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "new-turn" },
      }),
    ]);

    const watcher = new RolloutWatcher();
    await expect(watcher.getThreadActivity(path)).resolves.toEqual({
      activeTurnId: "new-turn",
      activeTurnIds: ["long-turn", "new-turn"],
      lastStartedAt: Date.parse("2026-04-04T18:00:00.100Z"),
      lastCompletedAt: null,
    });
  });

  test("prefers final_answer messages over fallback task_complete text", async () => {
    const { path, startedAt } = makeRollout([
      JSON.stringify({
        timestamp: "2026-04-04T18:00:00.100Z",
        type: "event_msg",
        payload: { type: "agent_message", phase: "commentary", message: "Working..." },
      }),
      JSON.stringify({
        timestamp: "2026-04-04T18:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Final answer text" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-04T18:00:01.500Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: "Fallback answer" },
      }),
    ]);

    const watcher = new RolloutWatcher();
    const result = await watcher.waitForTurnResult(path, startedAt, 1000);
    expect(result.turnId).toBe("turn-1");
    expect(result.finalText).toBe("Final answer text");
  });

  test("recovery can target a specific turn id instead of the next completed turn", async () => {
    const { path, startedAt } = makeRollout([
      JSON.stringify({
        timestamp: "2026-04-04T18:00:00.100Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "other-turn", last_agent_message: "Wrong turn result" },
      }),
      JSON.stringify({
        timestamp: "2026-04-04T18:00:02.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "target-turn", last_agent_message: "Expected recovered result" },
      }),
    ]);

    const watcher = new RolloutWatcher();
    const inspection = await watcher.inspectTurn(path, startedAt, { expectedTurnId: "target-turn" });
    expect(inspection.result?.turnId).toBe("target-turn");
    expect(inspection.result?.finalText).toBe("Expected recovered result");
  });

  test("recovery ignores unrelated completed turns when the expected turn id is missing", async () => {
    const { path, startedAt } = makeRollout([
      JSON.stringify({
        timestamp: "2026-04-04T18:00:01.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "other-turn", last_agent_message: "Wrong turn result" },
      }),
    ]);

    const watcher = new RolloutWatcher();
    const inspection = await watcher.inspectTurn(path, startedAt, { expectedTurnId: "target-turn" });
    expect(inspection.hasActivity).toBe(true);
    expect(inspection.result).toBeNull();
  });

  test("expected-turn recovery does not borrow final text from a superseding desktop turn", async () => {
    const { path, startedAt } = makeRollout([
      JSON.stringify({
        timestamp: "2026-04-04T18:00:00.100Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "target-turn" },
      }),
      JSON.stringify({
        timestamp: "2026-04-04T18:00:00.800Z",
        type: "event_msg",
        payload: { type: "agent_message", phase: "final_answer", message: "Target answer from streaming event" },
      }),
      JSON.stringify({
        timestamp: "2026-04-04T18:00:01.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "target-turn", last_agent_message: "Expected recovered result" },
      }),
      JSON.stringify({
        timestamp: "2026-04-04T18:00:01.200Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "desktop-turn" },
      }),
      JSON.stringify({
        timestamp: "2026-04-04T18:00:01.500Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Wrong desktop answer" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-04T18:00:02.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "desktop-turn", last_agent_message: "Wrong desktop complete" },
      }),
    ]);

    const watcher = new RolloutWatcher();
    const inspection = await watcher.inspectTurn(path, startedAt, { expectedTurnId: "target-turn" });
    expect(inspection.result?.turnId).toBe("target-turn");
    expect(inspection.result?.finalText).toBe("Expected recovered result");
  });

  test("expected-turn recovery fails closed when the expected completion has no final text", async () => {
    const { path, startedAt } = makeRollout([
      JSON.stringify({
        timestamp: "2026-04-04T18:00:00.100Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "target-turn" },
      }),
      JSON.stringify({
        timestamp: "2026-04-04T18:00:00.800Z",
        type: "event_msg",
        payload: { type: "agent_message", phase: "final_answer", message: "Unscoped target-looking text" },
      }),
      JSON.stringify({
        timestamp: "2026-04-04T18:00:01.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "target-turn" },
      }),
      JSON.stringify({
        timestamp: "2026-04-04T18:00:01.500Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "desktop-turn", last_agent_message: "Wrong desktop result" },
      }),
    ]);

    const watcher = new RolloutWatcher();
    const inspection = await watcher.inspectTurn(path, startedAt, { expectedTurnId: "target-turn" });
    expect(inspection.hasActivity).toBe(true);
    expect(inspection.result).toBeNull();
  });

  test("reuses the same watcher across appended rollout events", async () => {
    const { path, startedAt } = makeRollout([
      JSON.stringify({
        timestamp: "2026-04-04T18:00:00.100Z",
        type: "event_msg",
        payload: { type: "agent_message", phase: "commentary", message: "Working..." },
      }),
    ]);

    const watcher = new RolloutWatcher();
    expect((await watcher.inspectTurn(path, startedAt)).result).toBeNull();

    appendFileSync(path, `${JSON.stringify({
      timestamp: "2026-04-04T18:00:01.500Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: "Finished" },
    })}\n`, "utf8");

    const inspection = await watcher.inspectTurn(path, startedAt);
    expect(inspection.result?.turnId).toBe("turn-1");
    expect(inspection.result?.finalText).toBe("Finished");
  });

  test("handles appended partial json lines without producing false results", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-bridge-rollout-"));
    tempRoots.push(root);
    const path = join(root, "rollout.jsonl");
    const startedAt = Date.parse("2026-04-04T18:00:00.000Z");

    writeFileSync(path, `${JSON.stringify({
      timestamp: "2026-04-04T18:00:00.100Z",
      type: "event_msg",
      payload: { type: "agent_message", phase: "commentary", message: "Working..." },
    })}\n{"timestamp":"2026-04-04T18:00:02.000Z","type":"event_msg"`, "utf8");

    const watcher = new RolloutWatcher();
    expect((await watcher.inspectTurn(path, startedAt)).result).toBeNull();

    appendFileSync(
      path,
      ',"payload":{"type":"task_complete","turn_id":"turn-2","last_agent_message":"Recovered"}}' + "\n",
      "utf8",
    );

    const inspection = await watcher.inspectTurn(path, startedAt);
    expect(inspection.result?.turnId).toBe("turn-2");
    expect(inspection.result?.finalText).toBe("Recovered");
  });

  test("fails closed for shared-thread activity when the rollout file is missing", async () => {
    const watcher = new RolloutWatcher();
    await expect(watcher.getThreadActivity("/tmp/telegram-codex-bridge-rollout-does-not-exist.jsonl")).rejects.toThrow();
  });

  test("fails closed for shared-thread activity when the rollout file becomes empty", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-04T18:00:10.000Z"));
    const { path } = makeRollout([
      JSON.stringify({
        timestamp: "2026-04-04T18:00:00.100Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-open" },
      }),
    ]);

    const watcher = new RolloutWatcher();
    await expect(watcher.getThreadActivity(path)).resolves.toEqual({
      activeTurnId: "turn-open",
      activeTurnIds: ["turn-open"],
      lastStartedAt: Date.parse("2026-04-04T18:00:00.100Z"),
      lastCompletedAt: null,
    });

    writeFileSync(path, "", "utf8");

    await expect(watcher.getThreadActivity(path)).rejects.toThrow();
  });

  test("fails closed for shared-thread activity when the rollout file shrinks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-04T18:00:10.000Z"));
    const { path } = makeRollout([
      JSON.stringify({
        timestamp: "2026-04-04T18:00:00.100Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-open" },
      }),
      JSON.stringify({
        timestamp: "2026-04-04T18:00:01.000Z",
        type: "event_msg",
        payload: { type: "agent_message", phase: "commentary", message: "Working..." },
      }),
    ]);

    const watcher = new RolloutWatcher();
    await expect(watcher.getThreadActivity(path)).resolves.toEqual({
      activeTurnId: "turn-open",
      activeTurnIds: ["turn-open"],
      lastStartedAt: Date.parse("2026-04-04T18:00:00.100Z"),
      lastCompletedAt: null,
    });

    writeFileSync(path, `${JSON.stringify({
      timestamp: "2026-04-04T18:00:00.100Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-open" },
    })}\n`, "utf8");

    await expect(watcher.getThreadActivity(path)).rejects.toThrow();
  });
});
