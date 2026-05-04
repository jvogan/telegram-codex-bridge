import { open } from "node:fs/promises";

import type { BridgeState } from "../state.js";
import type { BridgeConfig } from "../config.js";
import type { BoundThread, BridgeMode, BridgeOwner, CallContextMessage, CallContextPack } from "../types.js";

interface ParsedRolloutLine {
  timestamp: string | null;
  type: string;
  payload: any;
}

const MAX_ROLLOUT_CONTEXT_BYTES = 256 * 1024;

async function readRolloutTail(path: string, maxBytes = MAX_ROLLOUT_CONTEXT_BYTES): Promise<string> {
  const handle = await open(path, "r");
  try {
    const details = await handle.stat();
    const readLength = Math.min(details.size, maxBytes);
    if (readLength <= 0) {
      return "";
    }
    const start = Math.max(0, details.size - readLength);
    const buffer = Buffer.alloc(readLength);
    const { bytesRead } = await handle.read(buffer, 0, readLength, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      text = text.replace(/^[^\n]*\n/, "");
    }
    return text;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function parseRolloutLines(raw: string): ParsedRolloutLine[] {
  return raw
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .flatMap(line => {
      try {
        const parsed = JSON.parse(line) as { timestamp?: string; type?: string; payload?: any };
        if (!parsed.type) {
          return [];
        }
        return [{
          timestamp: parsed.timestamp ?? null,
          type: parsed.type,
          payload: parsed.payload ?? null,
        }];
      } catch {
        return [];
      }
    });
}

function extractMessageText(payload: any): string {
  if (!payload || payload.type !== "message" || !Array.isArray(payload.content)) {
    return "";
  }
  return payload.content
    .flatMap((entry: any) => {
      if (typeof entry?.text === "string") {
        return [entry.text];
      }
      return [];
    })
    .join("\n")
    .trim();
}

function isRealtimeContextNoise(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return true;
  }
  if (normalized.startsWith("<turn_aborted>")) {
    return true;
  }
  return false;
}

function extractRecentTurns(lines: ParsedRolloutLine[], limit = 10): CallContextMessage[] {
  const messages = lines
    .filter(line => line.type === "response_item" && (line.payload?.role === "user" || line.payload?.role === "assistant"))
    .flatMap(line => {
      const text = extractMessageText(line.payload);
      if (!text || isRealtimeContextNoise(text)) {
        return [];
      }
      if (line.payload.role === "assistant" && line.payload.phase && line.payload.phase !== "final_answer") {
        return [];
      }
      return [{
        role: line.payload.role as "user" | "assistant",
        text,
        timestamp: line.timestamp,
        source: "thread" as const,
      }];
    });
  return messages.slice(-limit);
}

function compact(text: string, maxChars = 220): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function deriveGoals(turns: CallContextMessage[]): string[] {
  return turns
    .filter(turn => turn.role === "user")
    .slice(-3)
    .map(turn => compact(turn.text, 140));
}

function deriveSummary(turns: CallContextMessage[], mode: BridgeMode, owner: BridgeOwner, boundThread: BoundThread | null): string {
  const latestUser = [...turns].reverse().find(turn => turn.role === "user");
  const latestAssistant = [...turns].reverse().find(turn => turn.role === "assistant");
  return [
    boundThread ? `Bound to Codex thread ${boundThread.threadId} in ${boundThread.cwd}.` : "No bound desktop thread.",
    `Bridge mode is ${mode} and owner is ${owner}.`,
    latestUser ? `Latest user focus: ${compact(latestUser.text, 180)}` : null,
    latestAssistant ? `Latest assistant response: ${compact(latestAssistant.text, 180)}` : null,
  ].filter(Boolean).join(" ");
}

export async function buildCallContextPack(input: {
  callId: string;
  boundThread: BoundThread | null;
  mode: BridgeMode;
  owner: BridgeOwner;
  state: BridgeState;
}): Promise<CallContextPack> {
  const rawRollout = input.boundThread?.rolloutPath
    ? await readRolloutTail(input.boundThread.rolloutPath).catch(() => "")
    : "";
  const turns = extractRecentTurns(parseRolloutLines(rawRollout), 10);
  const pendingTasks = input.state.listPendingTasks(6).map(task => compact(`${task.kind}: ${task.text}`, 120));
  const operatorNotes = [
    `Provider overrides: ASR=${input.state.getProviderOverride("asr") ?? "default"}, `
      + `TTS=${input.state.getProviderOverride("tts") ?? "default"}, `
      + `Image=${input.state.getProviderOverride("image_generation") ?? "default"}`,
    `Sleeping=${input.state.isSleeping() ? "yes" : "no"}`,
  ];
  return {
    callId: input.callId,
    boundThreadId: input.boundThread?.threadId ?? null,
    cwd: input.boundThread?.cwd ?? null,
    mode: input.mode,
    owner: input.owner,
    sessionSummary: deriveSummary(turns, input.mode, input.owner, input.boundThread),
    recentTurns: turns,
    goals: deriveGoals(turns),
    openTasks: pendingTasks,
    queuedItems: pendingTasks,
    operatorNotes,
    generatedAt: Date.now(),
  };
}

export function buildRealtimeInstructions(config: BridgeConfig, contextPack: CallContextPack): string {
  const recentTurns = contextPack.recentTurns
    .map(turn => `- ${turn.role}: ${compact(turn.text, 180)}`)
    .join("\n");
  const goals = contextPack.goals.map(goal => `- ${goal}`).join("\n") || "- None recorded";
  const openTasks = contextPack.openTasks.map(task => `- ${task}`).join("\n") || "- None recorded";
  return [
    `You are ${config.branding.realtime_badge}, a temporary live voice sidecar for an existing Codex desktop session.`,
    "This live call is for discussion, clarification, planning, and capture.",
    "Do not claim to be the live desktop Codex thread itself.",
    "This call is only between you and the Telegram user who opened the Mini App.",
    "Do not claim that you can place phone calls to third parties, impersonate a human representative, or directly contact outside businesses from this audio session.",
    "Be concise and conversational in audio.",
    "At the end of the call, the bridge will create a handoff artifact for the Codex thread.",
    "",
    "Current session context:",
    contextPack.sessionSummary,
    "",
    "Current goals:",
    goals,
    "",
    "Open tasks or queued items:",
    openTasks,
    "",
    "Recent conversation turns:",
    recentTurns || "- No recent turns recorded",
  ].join("\n");
}
