import { describe, expect, test } from "vitest";

import {
  renderTeleportSuccess,
  renderThreadTeleportList,
  shortThreadId,
  threadActivityLabel,
} from "../src/core/telegram/thread-teleport.js";
import type { BoundThread } from "../src/core/types.js";

function thread(overrides: Partial<BoundThread> = {}): BoundThread {
  return {
    threadId: "019dd4c1-1f43-7570-afa4-b026fd23721a",
    cwd: "/repo",
    title: "Main repo",
    rolloutPath: "/repo/.codex/thread.jsonl",
    source: "desktop",
    updatedAt: 10_000,
    boundAt: 10_000,
    ...overrides,
  };
}

describe("thread teleport rendering", () => {
  test("shortens thread ids for status text", () => {
    expect(shortThreadId("short")).toBe("short");
    expect(shortThreadId("019dd4c1-1f43-7570-afa4-b026fd23721a")).toBe("019dd4c1-1f4...");
  });

  test("labels activity without exposing rollout contents", () => {
    expect(threadActivityLabel(null)).toBe("activity unknown");
    expect(threadActivityLabel({ activeTurnId: "turn-1234567890123", lastStartedAt: 1, lastCompletedAt: null })).toBe("active turn-1234567...");
    expect(threadActivityLabel({ activeTurnId: null, lastStartedAt: 2000, lastCompletedAt: 1000 })).toBe("active");
    expect(threadActivityLabel({ activeTurnId: null, lastStartedAt: 1000, lastCompletedAt: 2000 })).toBe("idle");
  });

  test("renders command-oriented thread list", () => {
    const list = renderThreadTeleportList({
      threads: [thread({ updatedAt: 1_700_000_010_000 })],
      boundThreadId: "019dd4c1-1f43-7570-afa4-b026fd23721a",
      activities: new Map([
        ["019dd4c1-1f43-7570-afa4-b026fd23721a", { activeTurnId: null, lastStartedAt: 8_000, lastCompletedAt: 9_000 }],
      ]),
      now: 1_700_000_012_000,
    });

    expect(list).toContain("Use /teleport <thread_id>");
    expect(list).toContain("bound | idle | updated 2s ago");
    expect(list).toContain("command: /teleport 019dd4c1-1f43-7570-afa4-b026fd23721a");
  });

  test("renders verified attach success with back command", () => {
    const success = renderTeleportSuccess({
      binding: thread({ cwd: "/repo-next", title: "Next" }),
      previousBinding: thread({ threadId: "previous-thread-1234567890", cwd: "/repo-prev" }),
      status: {
        mode: "shared-thread-resume",
        owner: "telegram",
        queueCount: 0,
        pendingApprovals: 0,
        binding: thread(),
      },
    });

    expect(success).toContain("Telegram is now attached");
    expect(success).toContain("Mode: shared-thread-resume");
    expect(success).toContain("Back: /teleport previous-thread-1234567890");
  });
});
