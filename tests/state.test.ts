import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "vitest";

import { ArtifactStore } from "../src/core/artifacts.js";
import { BridgeState } from "../src/core/state.js";
import type {
  ActiveCallRecord,
  ActiveTaskRecord,
  BoundThread,
  CallInboxItem,
  PendingCallHandoffRecord,
  QueuedTelegramTask,
  StoredArtifact,
} from "../src/core/types.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function createState(): BridgeState {
  const root = mkdtempSync(join(tmpdir(), "telegram-codex-bridge-test-"));
  tempRoots.push(root);
  return new BridgeState(root);
}

function localTimestamp(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute = 0,
  second = 0,
): number {
  return new Date(year, monthIndex, day, hour, minute, second).getTime();
}

describe("BridgeState", () => {
  test("round-trips queued tasks and provider overrides", () => {
    const state = createState();
    const task: QueuedTelegramTask = {
      id: "task-1",
      updateId: 42,
      chatId: "123",
      messageId: 5,
      kind: "text",
      text: "hello",
      forceSpeak: false,
      createdAt: Date.now(),
    };

    state.enqueueTask(task);
    state.setProviderOverride("tts", "openai");

    expect(state.nextPendingTask()).toEqual(task);
    expect(state.getProviderOverride("tts")).toBe("openai");
  });

  test("updates queued task payload for staged media", () => {
    const state = createState();
    const task: QueuedTelegramTask = {
      id: "task-image",
      updateId: 43,
      chatId: "123",
      messageId: 6,
      kind: "image",
      text: "look",
      photoFileId: "file-1",
      createdAt: Date.now(),
    };

    state.enqueueTask(task);
    state.replaceTask({
      ...task,
      stagedImagePath: "/tmp/staged.jpg",
    });

    expect(state.getTask(task.id)).toEqual({
      ...task,
      stagedImagePath: "/tmp/staged.jpg",
    });
  });

  test("lists undelivered image artifacts after a cutoff", () => {
    const state = createState();
    const imagePath = join(tempRoots[tempRoots.length - 1]!, "example.png");
    writeFileSync(imagePath, "png");
    const artifact: StoredArtifact = {
      id: "artifact-1",
      modality: "image",
      providerId: "google",
      source: "mcp",
      path: imagePath,
      mimeType: "image/png",
      fileName: "example.png",
      createdAt: Date.now(),
      metadata: { prompt: "example" },
      deliveredAt: null,
    };

    state.saveArtifact(artifact);

    expect(state.listRecentUndeliveredArtifacts("image", artifact.createdAt - 1)).toEqual([artifact]);
  });

  test("quarantines failed artifact deliveries until delivery succeeds", () => {
    const state = createState();
    const imagePath = join(tempRoots[tempRoots.length - 1]!, "failed.png");
    writeFileSync(imagePath, "png");
    const artifact: StoredArtifact = {
      id: "artifact-failed",
      modality: "image",
      providerId: "google",
      source: "mcp",
      path: imagePath,
      mimeType: "image/png",
      fileName: "failed.png",
      createdAt: Date.now(),
      metadata: { prompt: "example" },
      deliveredAt: null,
    };

    state.saveArtifact(artifact);
    state.recordArtifactDeliveryFailure("artifact-failed", new Error("upload blocked"), { quarantine: true });

    expect(state.getArtifactDeliveryState("artifact-failed")).toMatchObject({
      artifactId: "artifact-failed",
      attempts: 1,
      lastErrorText: "upload blocked",
    });
    expect(state.listRecentUndeliveredArtifacts("image", 0)).toEqual([]);

    state.markArtifactDelivered("artifact-failed");

    expect(state.getArtifactDeliveryState("artifact-failed")).toBeNull();
  });

  test("prunes missing artifact rows instead of returning stale undelivered artifacts", () => {
    const state = createState();
    const artifact: StoredArtifact = {
      id: "artifact-missing",
      modality: "image",
      providerId: "google",
      source: "mcp",
      path: join(tempRoots[tempRoots.length - 1]!, "missing.png"),
      mimeType: "image/png",
      fileName: "missing.png",
      createdAt: Date.now(),
      metadata: {},
      deliveredAt: null,
    };

    state.saveArtifact(artifact);

    expect(state.listRecentUndeliveredArtifacts("image", 0)).toEqual([]);
    expect(state.listArtifactsForCleanup({ olderThan: Date.now(), deliveredOnly: false })).toEqual([]);
  });

  test("round-trips bridge mode, owner, sleep state, and bound thread", () => {
    const state = createState();
    const binding: BoundThread = {
      threadId: "thread-123",
      cwd: "/tmp/workspace",
      rolloutPath: "/tmp/rollout.jsonl",
      source: "vscode",
      title: "Example",
      updatedAt: 123,
      boundAt: Date.now(),
    };

    state.setMode("shared-thread-resume");
    state.setOwner("desktop");
    state.setSleeping(true);
    state.setBoundThread(binding);

    expect(state.getMode("autonomous-thread")).toBe("shared-thread-resume");
    expect(state.getOwner("none")).toBe("desktop");
    expect(state.isSleeping()).toBe(true);
    expect(state.getBoundThread()).toEqual(binding);
  });

  test("defaults owner to none until explicitly set", () => {
    const state = createState();

    expect(state.getOwner()).toBe("none");
  });

  test("configures sqlite for bounded lock waits", () => {
    const state = createState();
    const synchronous = state.db.prepare("PRAGMA synchronous").get() as Record<string, number>;
    const busyTimeout = state.db.prepare("PRAGMA busy_timeout").get() as Record<string, number>;

    expect(Object.values(synchronous)).toContain(1);
    expect(Object.values(busyTimeout)).toContain(1000);
  });

  test("keeps sqlite state files private", () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-bridge-test-"));
    tempRoots.push(root);
    const dbPath = join(root, "bridge.sqlite");
    writeFileSync(dbPath, "");
    chmodSync(dbPath, 0o644);

    const state = new BridgeState(root);
    state.db.close();

    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
  });

  test("defaults realtime call-surface diagnostics to empty values", () => {
    const state = createState();
    const surface = state.getCallSurface();

    expect(surface.lastPublicProbeAt).toBeNull();
    expect(surface.lastPublicProbeReady).toBeNull();
    expect(surface.lastPublicProbeDetail).toBeNull();
    expect(surface.lastPublicUrl).toBeNull();
    expect(surface.lastHealthUrl).toBeNull();
    expect(surface.lastLaunchUrl).toBeNull();
    expect(surface.lastDisarmReason).toBeNull();
  });

  test("requeues processing work when no active handoff record exists", () => {
    const state = createState();
    const task: QueuedTelegramTask = {
      id: "task-requeue",
      updateId: 7,
      chatId: "123",
      messageId: 8,
      kind: "text",
      text: "retry me",
      createdAt: Date.now(),
    };

    state.enqueueTask(task);
    state.updateQueueStatus(task.id, "processing");

    expect(state.recoverInterruptedWork()).toBeNull();
    expect(state.nextPendingTask()).toEqual(task);
  });

  test("keeps the active in-flight task out of the replay queue during recovery", () => {
    const state = createState();
    const activeTask: QueuedTelegramTask = {
      id: "task-active",
      updateId: 10,
      chatId: "123",
      messageId: 20,
      kind: "text",
      text: "already handed to codex",
      createdAt: Date.now(),
    };
    const queuedTask: QueuedTelegramTask = {
      id: "task-queued",
      updateId: 11,
      chatId: "123",
      messageId: 21,
      kind: "text",
      text: "safe to retry",
      createdAt: Date.now(),
    };
    const recovery: ActiveTaskRecord = {
      queueId: activeTask.id,
      chatId: activeTask.chatId,
      placeholderMessageId: 99,
      startedAt: Date.now(),
      mode: "shared-thread-resume",
      stage: "submitted",
      threadId: "thread-1",
      boundThreadId: "thread-1",
      rolloutPath: "/tmp/rollout.jsonl",
      turnId: "turn-1",
    };

    state.enqueueTask(activeTask);
    state.enqueueTask(queuedTask);
    state.updateQueueStatus(activeTask.id, "processing", { placeholderMessageId: recovery.placeholderMessageId });
    state.updateQueueStatus(queuedTask.id, "processing");
    state.setActiveTask(recovery);

    expect(state.recoverInterruptedWork()).toEqual(recovery);
    expect(state.getQueueState(activeTask.id)?.status).toBe("processing");
    expect(state.getQueueState(queuedTask.id)?.status).toBe("pending");
  });

  test("round-trips active call state and call inbox items", () => {
    const state = createState();
    const call: ActiveCallRecord = {
      callId: "call-1",
      bridgeId: "bridge",
      status: "active",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      endedAt: null,
      endedReason: null,
      boundThreadId: "thread-1",
      cwd: "/tmp/workspace",
      gatewayCallId: null,
      telegramUserId: "123",
      telegramChatInstance: "abc",
      contextPack: null,
      eventPath: "/tmp/call-1/events.ndjson",
      transcriptPath: "/tmp/call-1/transcript.md",
      statePath: "/tmp/call-1/state.json",
      handoffJsonPath: "/tmp/call-1/handoff.json",
      handoffMarkdownPath: "/tmp/call-1/handoff.md",
      artifactAppendedAt: null,
      recapMessageId: null,
    };
    const inboxItem: CallInboxItem = {
      id: "call-item-1",
      callId: call.callId,
      updateId: 99,
      chatId: "123",
      messageId: 100,
      kind: "text",
      text: "note this",
      status: "queued",
      createdAt: Date.now(),
    };

    state.setActiveCall(call);
    state.enqueueCallInboxItem(inboxItem);
    state.updateCallInboxItem({ ...inboxItem, status: "included" });

    expect(state.getActiveCall()).toEqual(call);
    expect(state.listCallInboxItems(call.callId)).toEqual([{ ...inboxItem, status: "included" }]);
    expect(state.getCallInboxCount(call.callId)).toBe(1);

    state.clearCallInbox(call.callId);
    expect(state.getCallInboxCount(call.callId)).toBe(0);
  });

  test("protects active-call files and staged inbox assets from retention cleanup", () => {
    const state = createState();
    const root = tempRoots[tempRoots.length - 1]!;
    const call: ActiveCallRecord = {
      callId: "call-protected",
      bridgeId: "bridge",
      status: "finalizing",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      endedAt: Date.now(),
      endedReason: "browser_disconnect",
      boundThreadId: "thread-1",
      cwd: "/tmp/workspace",
      gatewayCallId: null,
      telegramUserId: "123",
      telegramChatInstance: null,
      contextPack: null,
      eventPath: join(root, "calls", "call-protected", "events.ndjson"),
      transcriptPath: join(root, "calls", "call-protected", "transcript.md"),
      statePath: join(root, "calls", "call-protected", "state.json"),
      handoffJsonPath: join(root, "calls", "call-protected", "handoff.json"),
      handoffMarkdownPath: join(root, "calls", "call-protected", "handoff.md"),
      artifactAppendedAt: null,
      recapMessageId: null,
    };

    state.setActiveCall(call);
    state.enqueueCallInboxItem({
      id: "call-item-1",
      callId: call.callId,
      updateId: 99,
      chatId: "123",
      messageId: 100,
      kind: "audio",
      text: "remember this audio",
      mediaPath: join(root, "inbound", "call-item-1.m4a"),
      transcriptPath: join(root, "artifacts", "call-item-1.txt"),
      status: "included",
      createdAt: Date.now(),
    });

    expect(state.getRetentionProtectedPaths()).toEqual(expect.arrayContaining([
      call.eventPath,
      call.transcriptPath,
      call.statePath,
      call.handoffJsonPath,
      call.handoffMarkdownPath,
      join(root, "calls", call.callId, "gateway-events.ndjson"),
      join(root, "inbound", "call-item-1.m4a"),
      join(root, "artifacts", "call-item-1.txt"),
    ]));
  });

  test("protects the default staged video path before video metadata is available", () => {
    const state = createState();
    const root = tempRoots[tempRoots.length - 1]!;
    const task: QueuedTelegramTask = {
      id: "task-video",
      updateId: 100,
      chatId: "123",
      messageId: 101,
      kind: "video",
      text: "inspect this video",
      videoFileId: "video-file",
      createdAt: Date.now(),
    };

    state.enqueueTask(task);

    expect(state.getRetentionProtectedPaths()).toEqual(expect.arrayContaining([
      join(root, "inbound", "task-video.mp4"),
      join(root, "inbound", "task-video.jpg"),
      join(root, "normalized", "task-video.wav"),
    ]));
  });

  test("tracks realtime usage by local day", () => {
    const state = createState();
    const midday = localTimestamp(2026, 3, 4, 12);
    const endedAt = localTimestamp(2026, 3, 4, 12, 34, 56);
    const evening = localTimestamp(2026, 3, 4, 18);
    const usageBefore = state.getRealtimeUsage(midday);

    expect(usageBefore.totalCallMs).toBe(0);
    expect(usageBefore.callCount).toBe(0);

    const usageAfter = state.recordRealtimeCallUsage(42_000, endedAt);

    expect(usageAfter.totalCallMs).toBe(42_000);
    expect(usageAfter.callCount).toBe(1);
    expect(state.getRealtimeUsage(evening)).toEqual(usageAfter);
  });

  test("records realtime usage at most once per call id", () => {
    const state = createState();
    const endedAt = localTimestamp(2026, 3, 4, 12, 34, 56);

    const first = state.recordRealtimeCallUsageOnce("call-1", 42_000, endedAt);
    const second = state.recordRealtimeCallUsageOnce("call-1", 42_000, endedAt);

    expect(first.recorded).toBe(true);
    expect(second.recorded).toBe(false);
    expect(state.getRealtimeUsage(endedAt).totalCallMs).toBe(42_000);
    expect(state.getRealtimeUsageRecord("call-1")).toMatchObject({
      callId: "call-1",
      durationMs: 42_000,
      endedAt,
    });
  });

  test("tracks gateway bridge connectivity and short-lived shutdown hints", () => {
    const state = createState();
    const now = Date.now();

    state.setGatewayBridgeConnection({
      connected: true,
      updatedAt: now,
    });
    state.setShutdownHint({
      source: "signal",
      initiatedBy: "bridgectl claim",
      requestedAt: now,
      details: {
        targetThreadId: "thread-2",
      },
    });

    expect(state.getGatewayBridgeConnection()).toEqual({
      connected: true,
      updatedAt: now,
    });
    expect(state.consumeShutdownHint(1_000)).toEqual({
      source: "signal",
      initiatedBy: "bridgectl claim",
      requestedAt: now,
      details: {
        targetThreadId: "thread-2",
      },
    });
    expect(state.getShutdownHint()).toBeNull();
  });

  test("reuses an undelivered staged file artifact for the same source path", async () => {
    const state = createState();
    const root = tempRoots[tempRoots.length - 1]!;
    const sourcePath = join(root, "report.pdf");
    writeFileSync(sourcePath, "%PDF-1.7");
    const artifacts = new ArtifactStore(root, state);

    const first = await artifacts.stageExistingFile({
      modality: "document",
      providerId: "bridge",
      source: "automatic",
      sourcePath,
      mimeType: "application/pdf",
    });
    const second = await artifacts.stageExistingFile({
      modality: "document",
      providerId: "bridge",
      source: "automatic",
      sourcePath,
      mimeType: "application/pdf",
    });

    expect(second.id).toBe(first.id);
    expect(state.listRecentUndeliveredArtifacts("document", 0)).toHaveLength(1);
  });

  test("can force a fresh staged file artifact for per-request delivery tracking", async () => {
    const state = createState();
    const root = tempRoots[tempRoots.length - 1]!;
    const sourcePath = join(root, "figure.jpg");
    writeFileSync(sourcePath, "jpeg");
    const artifacts = new ArtifactStore(root, state);

    const first = await artifacts.stageExistingFile({
      modality: "image",
      providerId: "bridge",
      source: "automatic",
      sourcePath,
      mimeType: "image/jpeg",
      metadata: { taskId: "task-1" },
    });
    const second = await artifacts.stageExistingFile({
      modality: "image",
      providerId: "bridge",
      source: "automatic",
      sourcePath,
      mimeType: "image/jpeg",
      metadata: { taskId: "task-2" },
      dedupeUndelivered: false,
    });

    expect(second.id).not.toBe(first.id);
    expect(state.listRecentUndeliveredArtifacts("image", 0).map(artifact => artifact.metadata.taskId)).toEqual([
      "task-1",
      "task-2",
    ]);
  });

  test("round-trips and resolves pending call handoffs", () => {
    const state = createState();
    const handoff: PendingCallHandoffRecord = {
      callId: "call-handoff-1",
      chatId: "123",
      createdAt: 1,
      updatedAt: 1,
      attemptCount: 1,
      lastError: "timed out",
      artifact: {
        callId: "call-handoff-1",
        boundThreadId: "thread-1",
        cwd: "/tmp/workspace",
        startedAt: 10,
        endedAt: 20,
        endedReason: "browser_disconnect",
        summary: "summary",
        decisions: [],
        actionItems: [],
        openQuestions: [],
        importantFacts: [],
        attachments: [],
        transcriptPath: "/tmp/calls/call-handoff-1/transcript.md",
      },
    };

    state.upsertPendingCallHandoff(handoff);

    expect(state.getPendingCallHandoffCount()).toBe(1);
    expect(state.getPendingCallHandoff(handoff.callId)).toEqual(handoff);

    const updated = state.updatePendingCallHandoff(handoff.callId, {
      attemptCount: 2,
      lastError: "still busy",
    });

    expect(updated?.attemptCount).toBe(2);
    expect(updated?.lastError).toBe("still busy");

    state.resolvePendingCallHandoff(handoff.callId);

    expect(state.getPendingCallHandoffCount()).toBe(0);
    expect(state.getPendingCallHandoff(handoff.callId)).toBeNull();
  });

  test("round-trips recent call summaries", () => {
    const state = createState();
    state.setRecentCallSummary({
      callId: "call-1",
      endedAt: 100,
      endedReason: "user_hangup",
      transcriptPath: "/tmp/calls/call-1/transcript.md",
      handoffJsonPath: "/tmp/calls/call-1/handoff.json",
      handoffMarkdownPath: "/tmp/calls/call-1/handoff.md",
      bundlePath: "/tmp/calls/call-1",
      hasUsableContent: true,
      handoffQueued: true,
      artifactAppendedAt: null,
      recapMessageId: 7,
    });

    expect(state.getRecentCallSummary()).toEqual({
      callId: "call-1",
      endedAt: 100,
      endedReason: "user_hangup",
      transcriptPath: "/tmp/calls/call-1/transcript.md",
      handoffJsonPath: "/tmp/calls/call-1/handoff.json",
      handoffMarkdownPath: "/tmp/calls/call-1/handoff.md",
      bundlePath: "/tmp/calls/call-1",
      hasUsableContent: true,
      handoffQueued: true,
      artifactAppendedAt: null,
      recapMessageId: 7,
    });

    expect(state.updateRecentCallSummary("call-1", {
      handoffQueued: false,
      artifactAppendedAt: 200,
    })).toMatchObject({
      callId: "call-1",
      handoffQueued: false,
      artifactAppendedAt: 200,
    });
  });

  test("deduplicates side-effectful Telegram update ids", () => {
    const state = createState();

    expect(state.claimProcessedTelegramUpdate(123, "command:/owner")).toBe(true);
    expect(state.claimProcessedTelegramUpdate(123, "command:/owner")).toBe(false);

    state.failProcessedTelegramUpdate(123, new Error("owner busy"));
    expect(state.getProcessedTelegramUpdate(123)).toMatchObject({
      updateId: 123,
      category: "command:/owner",
      status: "failed",
      errorText: "owner busy",
    });

    state.completeProcessedTelegramUpdate(123);
    expect(state.getProcessedTelegramUpdate(123)).toMatchObject({
      updateId: 123,
      status: "completed",
      errorText: null,
    });
  });

  test("deduplicates call handoff append lifecycle by call id", () => {
    const state = createState();

    expect(state.beginCallHandoffAppend("call-1", "hash-1")).toEqual({
      status: "started",
      acknowledgement: null,
      errorText: null,
    });
    expect(state.beginCallHandoffAppend("call-1", "hash-1")).toEqual({
      status: "already_in_progress",
      acknowledgement: null,
      errorText: null,
    });

    state.completeCallHandoffAppend("call-1", "ack");
    expect(state.beginCallHandoffAppend("call-1", "hash-1")).toEqual({
      status: "already_appended",
      acknowledgement: "ack",
      errorText: null,
    });

    expect(state.beginCallHandoffAppend("call-2", "hash-2").status).toBe("started");
    state.failCallHandoffAppend("call-2", new Error("timeout"));
    expect(state.beginCallHandoffAppend("call-2", "hash-2")).toEqual({
      status: "failed_previous",
      acknowledgement: null,
      errorText: "timeout",
    });
  });

  test("persists pending user-input diagnostics and fails them closed on restart", () => {
    const state = createState();

    state.recordPendingUserInputDiagnostic({
      localId: "input-1",
      requestId: "request-1",
      chatId: "123",
      promptMessageId: 77,
      questionsJson: JSON.stringify([{ id: "q1", question: "Answer?" }]),
      createdAt: 1,
    });

    expect(state.getPendingUserInputDiagnosticCount()).toBe(1);
    expect(state.listUserInputDiagnostics()).toEqual([
      expect.objectContaining({
        localId: "input-1",
        requestId: "request-1",
        chatId: "123",
        promptMessageId: 77,
        status: "pending",
      }),
    ]);

    expect(state.recoverPendingUserInputDiagnostics("daemon restart")).toBe(1);
    expect(state.getPendingUserInputDiagnosticCount()).toBe(0);
    expect(state.listUserInputDiagnostics()).toEqual([
      expect.objectContaining({
        localId: "input-1",
        status: "recovered_failed",
        errorText: "daemon restart",
      }),
    ]);
  });
});
