import type { ApprovalRecord } from "../types.js";

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface AgentMessageItem {
  id: string;
  type: "agentMessage";
  text: string;
  phase: "commentary" | "final_answer" | null;
}

export interface TurnResult {
  turnId: string;
  finalText: string;
  startedAt: number;
  completedAt: number;
}
