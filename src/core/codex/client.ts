import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

import type { Logger } from "../logger.js";
import { redactUrlForLogs } from "../redaction.js";
import type { JsonRpcId, JsonRpcRequest, JsonRpcResponse } from "./protocol.js";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class CodexAppServerClient extends EventEmitter {
  private process: ReturnType<typeof spawn> | null = null;
  private ws: WebSocket | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private exitPromise: Promise<number | null> | null = null;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly logger: Logger,
  ) {
    super();
  }

  private summarizeOutput(chunk: Buffer | string): Record<string, unknown> {
    const text = (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk).trim();
    return {
      byteLength: Buffer.byteLength(text, "utf8"),
      lineCount: text ? text.split(/\r?\n/).length : 0,
      text: text || "",
    };
  }

  async start(): Promise<void> {
    if (this.process) {
      throw new Error("Codex app-server process is already running.");
    }
    const child = spawn(this.command, this.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    this.process = child;
    this.exitPromise = new Promise<number | null>(resolve => {
    child.once("exit", code => {
        if (this.process === child) {
          this.process = null;
        }
        this.logger.warn("app-server exited", { code });
        this.rejectPending(new Error("Codex app-server exited before completing all requests."));
        this.emit("exit", code);
        resolve(code);
      });
    });
    child.stdout?.on("data", chunk => {
      this.logger.info("app-server stdout", this.summarizeOutput(chunk));
    });
    child.stderr?.on("data", chunk => {
      this.logger.warn("app-server stderr", this.summarizeOutput(chunk));
    });
  }

  async connect(url: string): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(url);
          ws.once("open", () => {
            this.ws = ws;
            ws.on("message", raw => this.handleMessage(raw.toString()));
            ws.on("error", error => this.emit("socketError", error));
            ws.on("close", () => {
              if (this.ws === ws) {
                this.ws = null;
              }
              this.rejectPending(new Error("Codex app-server websocket closed."));
              this.emit("close");
            });
            resolve();
          });
          ws.once("error", reject);
        });
        return;
      } catch {
        await sleep(200);
      }
    }
    throw new Error(`Unable to connect to Codex app-server at ${redactUrlForLogs(url)}`);
  }

  isConnected(): boolean {
    return Boolean(this.process && this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  private handleMessage(raw: string): void {
    const message = JSON.parse(raw) as JsonRpcResponse | JsonRpcRequest | { method: string; params?: unknown };
    if ("id" in message && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
        return;
      }
      pending.resolve(message.result);
      return;
    }
    if ("id" in message && "method" in message) {
      this.emit("serverRequest", message);
      return;
    }
    if ("method" in message) {
      this.emit("notification", message);
    }
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    if (!this.ws) {
      throw new Error("Codex app-server websocket is not connected.");
    }
    const id = this.nextRequestId++;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    const payload = JSON.stringify(request);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(payload, error => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  async respond(id: JsonRpcId, result: unknown): Promise<void> {
    if (!this.ws) {
      throw new Error("Codex app-server websocket is not connected.");
    }
    this.ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id,
      result,
    }));
  }

  async respondError(id: JsonRpcId, message: string): Promise<void> {
    if (!this.ws) {
      throw new Error("Codex app-server websocket is not connected.");
    }
    this.ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message,
      },
    }));
  }

  async close(): Promise<void> {
    if (this.ws) {
      await new Promise<void>(resolve => {
        const ws = this.ws!;
        this.ws = null;
        const finalize = (): void => resolve();
        if (ws.readyState === WebSocket.CLOSED) {
          finalize();
          return;
        }
        ws.once("close", finalize);
        ws.close();
        void sleep(1_000).then(() => {
          if (ws.readyState !== WebSocket.CLOSED) {
            ws.terminate();
          }
          finalize();
        });
      });
      this.ws = null;
    }
    if (this.process) {
      const child = this.process;
      child.kill("SIGTERM");
      await this.waitForExit(10_000).catch(async () => {
        if (!child.killed) {
          child.kill("SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
        await this.waitForExit(5_000).catch(() => undefined);
      });
    }
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private async waitForExit(timeoutMs: number): Promise<void> {
    if (!this.exitPromise) {
      return;
    }
    const promise = this.exitPromise;
    await Promise.race([
      promise,
      sleep(timeoutMs).then(() => {
        throw new Error(`Timed out waiting for Codex app-server to exit after ${timeoutMs}ms.`);
      }),
    ]);
    if (this.exitPromise === promise) {
      this.exitPromise = null;
    }
  }
}
