import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { BridgeConfig, BridgeEnv } from "../config.js";
import { BridgeState } from "../state.js";
import type { ActiveCallRecord, CallArtifact, CallContextPack, CallInboxItem, CallLedger } from "../types.js";
import { formatDisplayPath } from "../util/display-path.js";
import { ensureDir } from "../util/files.js";
import type { BridgeCallEvent } from "./protocol.js";
import { buildCallArtifact, CallSummarizer } from "./summarizer.js";

export class ClosedCallMutationError extends Error {
  constructor(message = "The live call is already ending and no longer accepts in-call items.") {
    super(message);
    this.name = "ClosedCallMutationError";
  }
}

interface PersistedCallState {
  callId: string;
  status: ActiveCallRecord["status"];
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
  endedReason: string | null;
  contextPack: CallContextPack | null;
  transcriptBlocks: Array<{ role: "user" | "assistant"; text: string; at: number }>;
  draftAssistantText: string;
  ledger: CallLedger;
}

function initialCallState(call: ActiveCallRecord, contextPack: CallContextPack | null): PersistedCallState {
  return {
    callId: call.callId,
    status: call.status,
    startedAt: call.startedAt,
    updatedAt: call.updatedAt,
    endedAt: call.endedAt,
    endedReason: call.endedReason,
    contextPack,
    transcriptBlocks: [],
    draftAssistantText: "",
    ledger: {
      decisions: [],
      actionItems: [],
      openQuestions: [],
      importantFacts: [],
      attachments: [],
    },
  };
}

function renderTranscript(state: PersistedCallState): string {
  const lines = [
    `# Call ${state.callId}`,
    "",
    ...state.transcriptBlocks.flatMap(block => [
      `## ${block.role === "user" ? "User" : "Assistant"} (${new Date(block.at).toISOString()})`,
      "",
      block.text,
      "",
    ]),
  ];
  if (state.draftAssistantText.trim()) {
    lines.push("## Assistant (draft)");
    lines.push("");
    lines.push(state.draftAssistantText.trim());
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

function renderHandoffMarkdown(artifact: CallArtifact, options: { demoPracticeMode?: boolean } = {}): string {
  const section = (title: string, values: string[]): string => values.length > 0
    ? [`## ${title}`, "", ...values.map(value => `- ${value}`), ""].join("\n")
    : "";
  const displayPath = (pathValue: string | null | undefined, emptyLabel = "none"): string => formatDisplayPath(pathValue, {
    demoPracticeMode: options.demoPracticeMode,
    emptyLabel,
  });
  const attachments = artifact.attachments.map(entry => {
    const parts = [`${entry.kind}: ${entry.text}`];
    if (entry.path) {
      parts.push(`path=${displayPath(entry.path)}`);
    }
    if (entry.transcriptPath) {
      parts.push(`transcript=${displayPath(entry.transcriptPath)}`);
    }
    return parts.join(" | ");
  });
  return [
    `# Call Handoff ${artifact.callId}`,
    "",
    `- Bound thread: ${artifact.boundThreadId ?? "(none)"}`,
    `- CWD: ${displayPath(artifact.cwd, "(none)")}`,
    `- Started: ${new Date(artifact.startedAt).toISOString()}`,
    `- Ended: ${new Date(artifact.endedAt).toISOString()}`,
    `- Reason: ${artifact.endedReason}`,
    `- Transcript: ${displayPath(artifact.transcriptPath)}`,
    "",
    "## Summary",
    "",
    artifact.summary,
    "",
    section("Decisions", artifact.decisions),
    section("Action Items", artifact.actionItems),
    section("Open Questions", artifact.openQuestions),
    section("Important Facts", artifact.importantFacts),
    section("Attachments", attachments),
  ].filter(Boolean).join("\n");
}

interface LoggedCallEvent {
  at: string;
  event: BridgeCallEvent;
}

function callRoot(callsRoot: string, callId: string): string {
  return join(callsRoot, callId);
}

function gatewayEventPath(callsRoot: string, callId: string): string {
  return join(callRoot(callsRoot, callId), "gateway-events.ndjson");
}

function eventLogPath(callsRoot: string, callId: string): string {
  return join(callRoot(callsRoot, callId), "events.ndjson");
}

function attachmentFromInboxItem(item: CallInboxItem): CallArtifact["attachments"][number] {
  return {
    id: item.id,
    kind: item.kind,
    text: item.kind === "document"
      ? [item.text, item.documentFileName ? `File name: ${item.documentFileName}` : null].filter(Boolean).join("\n")
      : item.transcriptText ?? item.text,
    ...(item.kind === "image" && item.stagedImagePath ? { path: item.stagedImagePath } : {}),
    ...(item.kind === "document" && item.documentPath ? { path: item.documentPath } : {}),
    ...(item.kind === "video" && item.videoPath ? { path: item.videoPath } : {}),
    ...(item.kind !== "image" && item.mediaPath ? { path: item.mediaPath } : {}),
    ...(item.transcriptPath ? { transcriptPath: item.transcriptPath } : {}),
  };
}

function callAcceptsInboxItems(status: PersistedCallState["status"]): boolean {
  return status === "starting" || status === "active" || status === "finalizing";
}

function applyEventToPersistedState(persisted: PersistedCallState, event: BridgeCallEvent): void {
  if (event.type === "call.started") {
    persisted.status = "active";
    return;
  }
  if (event.type === "user.transcript.final" && event.text.trim()) {
    persisted.transcriptBlocks.push({ role: "user", text: event.text.trim(), at: event.at });
    return;
  }
  if (event.type === "assistant.transcript.delta") {
    persisted.draftAssistantText += event.text;
    return;
  }
  if (event.type === "assistant.transcript.final") {
    const text = event.text.trim() || persisted.draftAssistantText.trim();
    if (text) {
      persisted.transcriptBlocks.push({ role: "assistant", text, at: event.at });
    }
    persisted.draftAssistantText = "";
    return;
  }
  if (event.type === "response.interrupted") {
    persisted.draftAssistantText = "";
  }
}

function parseLoggedEvents(raw: string): LoggedCallEvent[] {
  return raw
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .flatMap(line => {
      try {
        const parsed = JSON.parse(line) as LoggedCallEvent;
        if (!parsed?.event || typeof parsed.at !== "string") {
          return [];
        }
        return [parsed];
      } catch {
        return [];
      }
    });
}

export class CallStore {
  private readonly callsRoot: string;
  private readonly summarizer: CallSummarizer;
  private readonly mutationChains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly config: BridgeConfig,
    env: BridgeEnv,
    private readonly state: BridgeState,
  ) {
    this.callsRoot = ensureDir(join(config.storageRoot, "calls"));
    this.summarizer = new CallSummarizer(config, env);
  }

  async create(call: {
    callId: string;
    bridgeId: string;
    boundThreadId: string | null;
    cwd: string | null;
    gatewayCallId?: string | null;
    telegramUserId?: string | null;
    telegramChatInstance?: string | null;
    contextPack: CallContextPack | null;
  }): Promise<ActiveCallRecord> {
    const root = callRoot(this.callsRoot, call.callId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const active: ActiveCallRecord = {
      callId: call.callId,
      bridgeId: call.bridgeId,
      status: "starting",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      endedAt: null,
      endedReason: null,
      boundThreadId: call.boundThreadId,
      cwd: call.cwd,
      gatewayCallId: call.gatewayCallId ?? null,
      telegramUserId: call.telegramUserId ?? null,
      telegramChatInstance: call.telegramChatInstance ?? null,
      contextPack: call.contextPack,
      eventPath: eventLogPath(this.callsRoot, call.callId),
      transcriptPath: join(root, "transcript.md"),
      statePath: join(root, "state.json"),
      handoffJsonPath: join(root, "handoff.json"),
      handoffMarkdownPath: join(root, "handoff.md"),
      artifactAppendedAt: null,
      recapMessageId: null,
    };
    const persisted = initialCallState(active, call.contextPack);
    await writeFile(active.eventPath, "", { mode: 0o600 });
    await writeFile(gatewayEventPath(this.callsRoot, call.callId), "", { flag: "a", mode: 0o600 });
    await writeFile(active.statePath, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });
    await writeFile(active.transcriptPath, renderTranscript(persisted), { mode: 0o600 });
    this.state.setActiveCall(active);
    return active;
  }

  async appendEvent(call: ActiveCallRecord, event: BridgeCallEvent): Promise<ActiveCallRecord> {
    return await this.withCallMutation(call.callId, async () => {
      await appendFile(call.eventPath, `${JSON.stringify({ at: new Date(event.at).toISOString(), event })}\n`, { mode: 0o600 });
      const persisted = await this.readPersistedState(call);
      persisted.updatedAt = Date.now();
      applyEventToPersistedState(persisted, event);
      await this.writePersistedState(call, persisted);
      const nextCall: ActiveCallRecord = {
        ...call,
        status: persisted.status,
        updatedAt: persisted.updatedAt,
      };
      this.updateActiveCallIfCurrent(call.callId, nextCall);
      return nextCall;
    });
  }

  async attachInboxItem(call: ActiveCallRecord, item: CallInboxItem): Promise<void> {
    await this.withCallMutation(call.callId, async () => {
      const persisted = await this.readPersistedState(call);
      if (!callAcceptsInboxItems(persisted.status)) {
        throw new ClosedCallMutationError();
      }
      persisted.ledger.attachments = [
        ...persisted.ledger.attachments.filter(entry => entry.id !== item.id),
        attachmentFromInboxItem(item),
      ];
      persisted.updatedAt = Date.now();
      await this.writePersistedState(call, persisted);
    });
  }

  async updateContextPack(call: ActiveCallRecord, contextPack: CallContextPack): Promise<ActiveCallRecord> {
    return await this.withCallMutation(call.callId, async () => {
      const persisted = await this.readPersistedState(call);
      persisted.contextPack = contextPack;
      persisted.updatedAt = Date.now();
      await this.writePersistedState(call, persisted);
      const nextCall: ActiveCallRecord = {
        ...call,
        contextPack,
        updatedAt: persisted.updatedAt,
      };
      this.updateActiveCallIfCurrent(call.callId, nextCall);
      return nextCall;
    });
  }

  async finalize(call: ActiveCallRecord, options: { reason: string; endedAt?: number }): Promise<{ call: ActiveCallRecord; artifact: CallArtifact }> {
    return await this.withCallMutation(call.callId, async () => {
      const endedAt = options.endedAt ?? Date.now();
      const persisted = await this.readPersistedState(call);
      await this.hydrateFromGatewayEvents(call, persisted);
      persisted.status = options.reason === "interrupted" ? "interrupted" : "ended";
      persisted.endedAt = endedAt;
      persisted.endedReason = options.reason;
      persisted.updatedAt = endedAt;
      await this.writePersistedState(call, persisted);

      const nextCall: ActiveCallRecord = {
        ...call,
        status: persisted.status,
        updatedAt: endedAt,
        endedAt,
        endedReason: options.reason,
      };
      this.updateActiveCallIfCurrent(call.callId, nextCall);

      const transcript = await readFile(call.transcriptPath, "utf8").catch(() => "");
      const inboxItems = this.state.listCallInboxItems(call.callId);
      const attachmentsById = new Map(
        persisted.ledger.attachments.map(attachment => [attachment.id, attachment] as const),
      );
      for (const inboxItem of inboxItems) {
        if (!attachmentsById.has(inboxItem.id)) {
          attachmentsById.set(inboxItem.id, attachmentFromInboxItem(inboxItem));
        }
      }
      const summary = await this.summarizer.summarize({
        contextPack: persisted.contextPack,
        transcript,
        inboxItems,
      });
      const artifact = buildCallArtifact({
        callId: call.callId,
        boundThreadId: call.boundThreadId,
        cwd: call.cwd,
        startedAt: call.startedAt,
        endedAt,
        endedReason: options.reason,
        transcriptPath: call.transcriptPath,
        attachments: [...attachmentsById.values()],
        summary,
      });
      await writeFile(call.handoffJsonPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
      await writeFile(call.handoffMarkdownPath, `${renderHandoffMarkdown(artifact, {
        demoPracticeMode: this.config.presentation.demo_practice_mode,
      }).trim()}\n`, { mode: 0o600 });
      return { call: nextCall, artifact };
    });
  }

  markArtifactAppended(call: ActiveCallRecord): ActiveCallRecord {
    const nextCall: ActiveCallRecord = {
      ...call,
      artifactAppendedAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.updateActiveCallIfCurrent(call.callId, nextCall);
    return nextCall;
  }

  clearActiveCall(callId: string): void {
    if (this.state.getActiveCall()?.callId === callId) {
      this.state.setActiveCall(null);
    }
    this.state.clearCallInbox(callId);
  }

  private async readPersistedState(call: ActiveCallRecord): Promise<PersistedCallState> {
    const raw = await readFile(call.statePath, "utf8");
    return JSON.parse(raw) as PersistedCallState;
  }

  private async hydrateFromGatewayEvents(call: ActiveCallRecord, persisted: PersistedCallState): Promise<void> {
    const gatewayPath = gatewayEventPath(this.callsRoot, call.callId);
    const gatewayRaw = await readFile(gatewayPath, "utf8").catch(() => "");
    if (!gatewayRaw.trim()) {
      return;
    }

    const existingRaw = await readFile(call.eventPath, "utf8").catch(() => "");
    const existingKeys = new Set(
      parseLoggedEvents(existingRaw).map(entry => JSON.stringify(entry.event)),
    );
    const gatewayEvents = parseLoggedEvents(gatewayRaw);
    const missingEvents = gatewayEvents.filter(entry => !existingKeys.has(JSON.stringify(entry.event)));
    if (missingEvents.length === 0) {
      return;
    }

    for (const entry of missingEvents) {
      applyEventToPersistedState(persisted, entry.event);
    }
    await appendFile(
      call.eventPath,
      missingEvents.map(entry => `${JSON.stringify(entry)}\n`).join(""),
      { mode: 0o600 },
    );
  }

  private async writePersistedState(call: ActiveCallRecord, persisted: PersistedCallState): Promise<void> {
    await writeFile(call.statePath, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });
    await writeFile(call.transcriptPath, renderTranscript(persisted), { mode: 0o600 });
  }

  private updateActiveCallIfCurrent(callId: string, nextCall: ActiveCallRecord): void {
    if (this.state.getActiveCall()?.callId === callId) {
      this.state.setActiveCall(nextCall);
    }
  }

  private async withCallMutation<T>(callId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationChains.get(callId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    const cleanup = next.catch(() => undefined).finally(() => {
      if (this.mutationChains.get(callId) === cleanup) {
        this.mutationChains.delete(callId);
      }
    });
    this.mutationChains.set(callId, cleanup);
    return await next;
  }
}
