import type { ActiveCallRecord, CallContextPack } from "../types.js";

export interface RealtimeBridgeStatusPayload {
  bridgeId: string;
  mode: string;
  owner: string;
  boundThreadId: string | null;
  cwd: string | null;
  activeCallId: string | null;
}

export interface RealtimeCallPreparePayload {
  callId: string;
  bridgeId: string;
  telegramUserId: string | null;
  telegramChatInstance: string | null;
}

export interface RealtimeCallPrepareResult {
  allowed: boolean;
  reason?: string;
  call?: ActiveCallRecord;
  contextPack?: CallContextPack;
  maxCallMs?: number;
}

export type BridgeCallEvent =
  | { type: "call.started"; at: number }
  | { type: "call.start_failed"; at: number; message: string }
  | { type: "call.ended"; at: number; reason: string }
  | { type: "call.idle_warning"; at: number }
  | { type: "vad"; at: number; state: "speech_started" | "speech_stopped" }
  | { type: "user.transcript.final"; at: number; text: string }
  | { type: "assistant.transcript.delta"; at: number; text: string }
  | { type: "assistant.transcript.final"; at: number; text: string }
  | { type: "response.interrupted"; at: number; itemId?: string; audioEndMs?: number }
  | { type: "raw"; at: number; eventType: string; payload: Record<string, unknown> };

export interface RealtimeCallEventPayload {
  callId: string;
  event: BridgeCallEvent;
}

export interface RealtimeCallHangupPayload {
  callId: string;
  reason: string;
  events?: BridgeCallEvent[];
}

export type BridgeControlEnvelope =
  | { type: "bridge.hello"; payload: RealtimeBridgeStatusPayload }
  | { type: "bridge.status"; payload: RealtimeBridgeStatusPayload }
  | { id: string; type: "call.prepare"; payload: RealtimeCallPreparePayload }
  | { replyTo: string; type: "call.prepare.result"; payload: RealtimeCallPrepareResult }
  | { type: "call.event"; payload: RealtimeCallEventPayload }
  | { type: "call.hangup"; payload: RealtimeCallHangupPayload };
