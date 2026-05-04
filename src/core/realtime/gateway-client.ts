import { EventEmitter } from "node:events";

import WebSocket from "ws";

import type { BridgeConfig, BridgeEnv } from "../config.js";
import type { Logger } from "../logger.js";
import type { ActiveCallRecord, CallContextPack } from "../types.js";
import type {
  BridgeCallEvent,
  BridgeControlEnvelope,
  RealtimeBridgeStatusPayload,
  RealtimeCallEventPayload,
  RealtimeCallHangupPayload,
  RealtimeCallPreparePayload,
  RealtimeCallPrepareResult,
} from "./protocol.js";

export function deriveControlUrl(config: BridgeConfig): string {
  if (config.realtime.control_url) {
    return config.realtime.control_url;
  }
  return `ws://${config.realtime.gateway_host}:${config.realtime.gateway_port}/ws/bridge`;
}

type PendingResolver = {
  resolve(payload: unknown): void;
  reject(error: Error): void;
};

export interface PrepareCallResult {
  call: ActiveCallRecord;
  contextPack: CallContextPack;
  maxCallMs: number;
}

export class RealtimeGatewayClient extends EventEmitter {
  private socket: WebSocket | null = null;
  private readonly controlUrl: string;
  private readonly pending = new Map<string, PendingResolver>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private connected = false;
  private messageChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: BridgeConfig,
    private readonly env: BridgeEnv,
    private readonly logger: Logger,
  ) {
    super();
    this.controlUrl = deriveControlUrl(config);
  }

  isEnabled(): boolean {
    return this.config.realtime.enabled && Boolean(this.env.realtimeControlSecret);
  }

  isConnected(): boolean {
    return this.connected;
  }

  async start(status: RealtimeBridgeStatusPayload): Promise<void> {
    if (!this.isEnabled() || this.socket) {
      return;
    }
    this.closed = false;
    try {
      await this.connect(status);
    } catch (error) {
      this.socket = null;
      this.setConnected(false);
      this.scheduleReconnect(status);
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.socket) {
      return;
    }
    const socket = this.socket;
    this.socket = null;
    await new Promise<void>(resolve => {
      socket.once("close", () => resolve());
      socket.close();
    }).catch(() => undefined);
    this.setConnected(false);
  }

  async sendStatus(status: RealtimeBridgeStatusPayload): Promise<void> {
    await this.send({ type: "bridge.status", payload: status });
  }

  async notifyCallEvent(payload: RealtimeCallEventPayload): Promise<void> {
    await this.send({ type: "call.event", payload });
  }

  async requestHangup(payload: RealtimeCallHangupPayload): Promise<boolean> {
    return await this.send({ type: "call.hangup", payload });
  }

  onPrepareCall(handler: (payload: RealtimeCallPreparePayload) => Promise<PrepareCallResult>): void {
    this.on("prepareCall", handler);
  }

  onCallEvent(handler: (payload: RealtimeCallEventPayload) => Promise<void>): void {
    this.on("callEvent", handler);
  }

  onHangupRequest(handler: (payload: RealtimeCallHangupPayload) => Promise<void>): void {
    this.on("hangupRequest", handler);
  }

  onConnectionStateChange(handler: (connected: boolean) => void): void {
    this.on("connectionState", handler);
  }

  private async connect(status: RealtimeBridgeStatusPayload): Promise<void> {
    const socket = new WebSocket(this.controlUrl, {
      headers: {
        "x-bridge-id": this.config.realtime.bridge_id,
        "x-bridge-secret": this.env.realtimeControlSecret ?? "",
      },
    });
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", error => reject(error));
    });
    this.setConnected(true);
    socket.on("message", data => {
      this.messageChain = this.messageChain
        .then(() => this.handleMessage(String(data)))
        .catch(error => {
          this.logger.warn("realtime gateway message handling failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    });
    socket.on("close", () => {
      this.setConnected(false);
      this.socket = null;
      this.scheduleReconnect(status);
    });
    socket.on("error", error => {
      this.logger.warn("realtime gateway socket error", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    await this.send({ type: "bridge.hello", payload: status });
  }

  private scheduleReconnect(status: RealtimeBridgeStatusPayload): void {
    if (this.closed || this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(status).catch(error => {
        this.logger.warn("failed to reconnect realtime gateway client", {
          error: error instanceof Error ? error.message : String(error),
        });
        this.scheduleReconnect(status);
      });
    }, 2_000);
  }

  private setConnected(value: boolean): void {
    if (this.connected === value) {
      return;
    }
    this.connected = value;
    this.emit("connectionState", value);
  }

  private async handleMessage(raw: string): Promise<void> {
    const parsed = JSON.parse(raw) as BridgeControlEnvelope;
    if ("replyTo" in parsed) {
      const pending = this.pending.get(parsed.replyTo);
      if (!pending) {
        return;
      }
      this.pending.delete(parsed.replyTo);
      pending.resolve((parsed as any).payload);
      return;
    }
    if ("id" in parsed && parsed.type === "call.prepare") {
      const listeners = this.listeners("prepareCall");
      if (listeners.length === 0) {
        await this.send({
          replyTo: parsed.id,
          type: "call.prepare.result",
          payload: {
            allowed: false,
            reason: "Bridge has no prepareCall handler.",
          },
        });
        return;
      }
      try {
        const result = await (listeners[0] as (payload: RealtimeCallPreparePayload) => Promise<PrepareCallResult>)(parsed.payload);
        await this.send({
          replyTo: parsed.id,
          type: "call.prepare.result",
          payload: {
            allowed: true,
            call: result.call,
            contextPack: result.contextPack,
            maxCallMs: result.maxCallMs,
          },
        });
      } catch (error) {
        await this.send({
          replyTo: parsed.id,
          type: "call.prepare.result",
          payload: {
            allowed: false,
            reason: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    if (!("id" in parsed) && parsed.type === "call.event") {
      await Promise.all(this.listeners("callEvent").map(listener =>
        (listener as (payload: RealtimeCallEventPayload) => Promise<void>)(parsed.payload),
      ));
      return;
    }
    if (!("id" in parsed) && parsed.type === "call.hangup") {
      await Promise.all(this.listeners("hangupRequest").map(listener =>
        (listener as (payload: RealtimeCallHangupPayload) => Promise<void>)(parsed.payload),
      ));
    }
  }

  private async send(message: BridgeControlEnvelope): Promise<boolean> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.socket.send(JSON.stringify(message));
    return true;
  }
}
