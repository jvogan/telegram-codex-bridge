import { describe, expect, test } from "vitest";

import {
  describeLiveCallPriorityHint,
  describeCallStartBlocker,
  resolveCallStartResolution,
  summarizeRecentCallSurfaceEvents,
  summarizeRecentCall,
  summarizeRecentFailedTask,
} from "../src/core/operator-diagnostics.js";
import type {
  ActiveTaskRecord,
  RecentCallSummary,
  RecentFailedTaskRecord,
  RealtimeCallSurfaceRecord,
} from "../src/core/types.js";

describe("operator diagnostics", () => {
  test("explains the highest-priority call blocker", () => {
    const activeTask: ActiveTaskRecord = {
      queueId: "task-1",
      chatId: "123",
      placeholderMessageId: 1,
      startedAt: 1_000,
      mode: "shared-thread-resume",
      stage: "submitted",
      threadId: "thread-1",
      boundThreadId: "thread-1",
      rolloutPath: null,
      turnId: "019d740e-809e-7e02-b219-e120a57d90fc",
    };

    expect(describeCallStartBlocker({
      activeTask,
      activeCall: null,
      queuedTasks: 0,
      pendingApprovals: 0,
      pendingCallHandoffs: 0,
      owner: "telegram",
      binding: null,
      now: 4_000,
    })).toContain("active Telegram task task-1");
  });

  test("surfaces an active bound desktop turn after bridge-local blockers clear", () => {
    expect(describeCallStartBlocker({
      activeTask: null,
      activeCall: null,
      queuedTasks: 0,
      pendingApprovals: 0,
      pendingCallHandoffs: 0,
      owner: "telegram",
      binding: {
        threadId: "thread-1",
        cwd: "/repo",
        rolloutPath: "/tmp/rollout.jsonl",
        source: "vscode",
        boundAt: 1_000,
      },
      desktopTurnId: "019d740e-809e-7e02-b219-e120a57d90fc",
    })).toBe("desktop Codex turn 019d740e-809e-7e02-b219-e120a57d90fc is already active");
  });

  test("treats active task and queue backlog as soft conditions for explicit live calls", () => {
    const resolution = resolveCallStartResolution({
      activeTask: {
        queueId: "task-1",
        chatId: "123",
        placeholderMessageId: 1,
        startedAt: 1_000,
        mode: "shared-thread-resume",
        stage: "submitted",
        threadId: "thread-1",
        boundThreadId: "thread-1",
        rolloutPath: null,
        turnId: "019d740e-809e-7e02-b219-e120a57d90fc",
      },
      activeCall: null,
      queuedTasks: 2,
      pendingApprovals: 0,
      pendingCallHandoffs: 0,
      owner: "telegram",
      binding: {
        threadId: "thread-1",
        cwd: "/repo",
        rolloutPath: "/tmp/rollout.jsonl",
        source: "vscode",
        boundAt: 1_000,
      },
      desktopTurnId: "turn-42",
      explicitLiveCall: true,
      now: 2_000,
    });

    expect(resolution).toEqual({
      blocked: false,
      summary: "active Telegram task task-1 (submitted, 1s) will be interrupted by explicit /call",
      nextStep: "Send /call now; the bridge will interrupt the in-flight Telegram task and switch into live calling.",
    });
  });

  test("lets explicit live calls bypass pending call handoffs", () => {
    expect(resolveCallStartResolution({
      activeTask: null,
      activeCall: null,
      queuedTasks: 0,
      pendingApprovals: 0,
      pendingCallHandoffs: 1,
      owner: "telegram",
      binding: {
        threadId: "thread-1",
        cwd: "/repo",
        rolloutPath: "/tmp/rollout.jsonl",
        source: "vscode",
        boundAt: 1_000,
      },
      explicitLiveCall: true,
    })).toEqual({
      blocked: false,
      summary: "1 pending call handoff waiting; explicit /call will bypass the append backlog",
      nextStep: "Send /call now; the bridge will pause the pending handoff append and prioritize the live call.",
    });
  });

  test("does not soft-bypass an unverified desktop turn", () => {
    expect(resolveCallStartResolution({
      activeTask: null,
      activeCall: null,
      queuedTasks: 0,
      pendingApprovals: 0,
      pendingCallHandoffs: 0,
      owner: "telegram",
      binding: {
        threadId: "thread-1",
        cwd: "/repo",
        rolloutPath: "/tmp/rollout.jsonl",
        source: "vscode",
        boundAt: 1_000,
      },
      desktopTurnId: "(unverified)",
      explicitLiveCall: true,
    })).toEqual({
      blocked: true,
      summary: "desktop Codex turn activity could not be verified safely",
      nextStep: "Wait for the current desktop turn to settle or repair rollout visibility, then retry /call.",
    });
  });

  test("does not soft-bypass a malformed desktop turn id", () => {
    expect(resolveCallStartResolution({
      activeTask: null,
      activeCall: null,
      queuedTasks: 0,
      pendingApprovals: 0,
      pendingCallHandoffs: 0,
      owner: "telegram",
      binding: {
        threadId: "thread-1",
        cwd: "/repo",
        rolloutPath: "/tmp/rollout.jsonl",
        source: "vscode",
        boundAt: 1_000,
      },
      desktopTurnId: "turn-42",
      explicitLiveCall: true,
    })).toEqual({
      blocked: true,
      summary: "desktop Codex turn activity could not be verified safely",
      nextStep: "Wait for the current desktop turn to settle or repair rollout visibility, then retry /call.",
    });
  });

  test("returns a blocked resolution with remediation for queue blockers", () => {
    expect(resolveCallStartResolution({
      activeTask: null,
      activeCall: null,
      queuedTasks: 2,
      pendingApprovals: 0,
      pendingCallHandoffs: 0,
      owner: "telegram",
      binding: {
        threadId: "thread-1",
        cwd: "/repo",
        rolloutPath: "/tmp/rollout.jsonl",
        source: "vscode",
        boundAt: 1_000,
      },
    })).toEqual({
      blocked: true,
      summary: "2 queued Telegram tasks waiting",
      nextStep: "Wait for queued Telegram tasks to drain, then retry /call.",
    });
  });

  test("explains when /call can jump ahead of queued work", () => {
    expect(describeLiveCallPriorityHint({
      activeTask: null,
      queuedTasks: 2,
      pendingCallHandoffs: 0,
    })).toBe("/call can jump ahead of queued Telegram work.");
  });

  test("prefers interactive blocker details after bridge-local blockers clear", () => {
    expect(resolveCallStartResolution({
      activeTask: null,
      activeCall: null,
      queuedTasks: 0,
      pendingApprovals: 0,
      pendingCallHandoffs: 0,
      owner: "telegram",
      binding: {
        threadId: "thread-1",
        cwd: "/repo",
        rolloutPath: "/tmp/rollout.jsonl",
        source: "vscode",
        boundAt: 1_000,
      },
      interactiveBlocker: {
        summary: "Desktop turn busy.",
        nextStep: "Wait for the current desktop turn to finish, then retry /call.",
      },
    })).toEqual({
      blocked: true,
      summary: "Desktop turn busy.",
      nextStep: "Wait for the current desktop turn to finish, then retry /call.",
    });
  });

  test("renders recent failed task details", () => {
    const failed: RecentFailedTaskRecord = {
      task: {
        id: "failed-1",
        updateId: 1,
        chatId: "123",
        messageId: 1,
        kind: "document",
        text: "summarize this file",
        createdAt: 1_000,
      },
      errorText: "provider timeout",
      updatedAt: 5_000,
    };

    expect(summarizeRecentFailedTask(failed, 8_000)).toEqual({
      label: "failed-1:document (3s ago)",
      error: "provider timeout",
      updatedAt: new Date(5_000).toISOString(),
    });
  });

  test("hides stale recent call summaries after bundle cleanup", () => {
    const repoRoot = "/repo";
    const summary: RecentCallSummary = {
      callId: "call-1",
      endedAt: 10_000,
      endedReason: "user_hangup",
      transcriptPath: "/repo/fixtures/missing-transcript.md",
      handoffJsonPath: "/repo/fixtures/missing-handoff.json",
      handoffMarkdownPath: "/repo/fixtures/missing-handoff.md",
      bundlePath: "/repo/fixtures",
      hasUsableContent: true,
      handoffQueued: true,
      artifactAppendedAt: null,
      recapMessageId: 1,
    };

    const rendered = summarizeRecentCall(summary, repoRoot);

    expect(rendered).toEqual({
      label: "none",
      endedAt: "none",
      transcript: "none",
      handoff: "none",
      bundle: "none",
      appendStatus: "none",
    });
  });

  test("renders recent /call surface events in reverse chronological order", () => {
    const surface: RealtimeCallSurfaceRecord = {
      armed: false,
      armedAt: null,
      armedBy: null,
      expiresAt: null,
      lastActivityAt: null,
      lastPublicProbeAt: null,
      lastPublicProbeReady: null,
      lastPublicProbeDetail: null,
      lastPublicUrl: null,
      lastHealthUrl: null,
      lastLaunchUrl: null,
      lastDisarmReason: "daemon_finally",
      launchTokenId: null,
      launchTokenBridgeId: null,
      launchTokenTelegramUserId: null,
      launchTokenTelegramChatInstance: null,
      launchTokenReservedAt: null,
      launchTokenExpiresAt: null,
      tunnelMode: "managed-quick-cloudflared",
      tunnelPid: null,
      tunnelUrl: null,
      tunnelStartedAt: null,
      recentEvents: [
        { at: 1_000, action: "arm", outcome: "ok", source: "telegram /call enable", detail: "surface armed" },
        { at: 2_000, action: "start", outcome: "blocked", source: "telegram /call", detail: "queue still draining" },
      ],
    };

    expect(summarizeRecentCallSurfaceEvents(surface, 3_000)).toEqual([
      "start blocked via telegram /call (1s ago): queue still draining",
      "arm ok via telegram /call enable (2s ago): surface armed",
    ]);
  });
});
