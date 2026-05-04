import "dotenv/config";

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocketServer, WebSocket } from "ws";

import { loadBridgeEnv, loadConfig, requireTelegramBotToken } from "../core/config.js";
import { createLogger } from "../core/logger.js";
import { buildRealtimeInstructions } from "../core/realtime/context.js";
import {
  releaseTimedAttempt,
  reserveTimedAttempt,
  registerTimedAttempt,
  resolveGatewayClientIp,
} from "../core/realtime/gateway-security.js";
import { createRequestAbortController } from "../core/realtime/request-abort.js";
import type { BridgeCallEvent, BridgeControlEnvelope, RealtimeBridgeStatusPayload } from "../core/realtime/protocol.js";
import {
  cleanupStaleLaunchTokenReservation,
  disarmCallSurface,
  getRealtimeTunnelMode,
  invalidateLaunchToken,
  isLaunchTokenValid,
  recordCallSurfaceDisarmReason,
  releaseLaunchTokenReservation,
  reserveLaunchTokenChatInstance,
  resolvePublicBaseUrl,
} from "../core/realtime/surface.js";
import { verifyTelegramInitData } from "../core/realtime/telegram-auth.js";
import { ensureManagedTunnelStopped } from "../core/realtime/tunnel.js";
import { renderMiniAppHtml } from "../core/realtime/webapp.js";
import { BridgeState } from "../core/state.js";

const entryDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(entryDir, "../..");
process.env.BRIDGE_CONFIG_PATH ??= join(repoRoot, "bridge.config.toml");
process.title = "telegram-codex-bridge-realtime-gateway";

const logger = createLogger("realtime-gateway");
const config = loadConfig();
const env = loadBridgeEnv(config);
const state = new BridgeState(config.storageRoot);
const botToken = requireTelegramBotToken(env);
const queuedBridgeEvents = new Map<string, BridgeControlEnvelope[]>();
const CALL_FINALIZE_GRACE_MS = 4_000;
const CALL_SOCKET_AUTH_TIMEOUT_MS = 5_000;
const CALL_SOCKET_AUTH_FAILURE_WINDOW_MS = 30_000;
const CALL_SOCKET_AUTH_FAILURE_LIMIT = 3;
const CALL_SOCKET_MAX_PAYLOAD_BYTES = 256 * 1024;
const OPENAI_CLIENT_SECRET_TIMEOUT_MS = 15_000;
const MINIAPP_RATE_LIMIT_WINDOW_MS = 10 * 60_000;
const MINIAPP_RATE_LIMIT_PER_IP = 15;
const MINIAPP_RATE_LIMIT_PER_TOKEN = 20;
const bootstrapAttemptsByIp = new Map<string, number[]>();
const bootstrapAttemptsByBridge = new Map<string, number[]>();
const bootstrapAttemptsByUser = new Map<string, number[]>();
const callSocketAuthFailures = new Map<string, number[]>();
const miniAppAttemptsByIp = new Map<string, number[]>();
const miniAppAttemptsByToken = new Map<string, number[]>();

interface BridgePeer {
  socket: WebSocket;
  status: RealtimeBridgeStatusPayload | null;
  pending: Map<string, (payload: any) => void>;
}

interface CallSession {
  callId: string;
  bridgeId: string;
  clientToken: string;
  launchToken: string;
  maxCallMs: number;
  userId: string | null;
  chatInstance: string | null;
  browserSocket: WebSocket | null;
  createdAt: number;
  expiresAt: number;
  browserConnected: boolean;
  started: boolean;
  cleanupTimer: NodeJS.Timeout | null;
  startupTimer: NodeJS.Timeout | null;
  maxDurationTimer: NodeJS.Timeout | null;
  finalizeTimer: NodeJS.Timeout | null;
  endingReason: string | null;
  endedAt: number | null;
  gatewayEventPath: string;
  logChain: Promise<void>;
}

const bridges = new Map<string, BridgePeer>();
const calls = new Map<string, CallSession>();

function getCallSurface() {
  const surface = state.getCallSurface(getRealtimeTunnelMode(config));
  const cleaned = cleanupStaleLaunchTokenReservation(surface);
  if (cleaned !== surface) {
    setCallSurface(cleaned);
  }
  return cleaned;
}

function setCallSurface(surface: ReturnType<typeof getCallSurface>): void {
  state.setCallSurface({
    ...surface,
    tunnelMode: config.realtime.tunnel_mode ?? (config.realtime.public_url ? "static-public-url" : "managed-quick-cloudflared"),
  });
}

function consumeRateLimit(map: Map<string, number[]>, key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const entries = (map.get(key) ?? []).filter(timestamp => now - timestamp < windowMs);
  if (entries.length >= limit) {
    return false;
  }
  entries.push(now);
  map.set(key, entries);
  return true;
}

function clientIp(req: import("node:http").IncomingMessage): string {
  return resolveGatewayClientIp(req.socket.remoteAddress, req.headers);
}

function preparedCallCountForBridge(bridgeId: string): number {
  return [...calls.values()].filter(call => call.bridgeId === bridgeId && !call.endedAt && !call.endingReason).length;
}

function launchTokenStatus(
  token: string | null | undefined,
  bridgeId?: string | null,
  telegramUserId?: string | null,
  telegramChatInstance?: string | null,
): { ok: boolean; expired: boolean; surface: ReturnType<typeof getCallSurface> } {
  const surface = getCallSurface();
  if (!surface.armed || !token || !surface.launchTokenId) {
    return { ok: false, expired: false, surface };
  }
  if (surface.launchTokenId !== token) {
    return { ok: false, expired: false, surface };
  }
  if (!surface.launchTokenExpiresAt || surface.launchTokenExpiresAt <= Date.now()) {
    return { ok: false, expired: true, surface };
  }
  return {
    ok: isLaunchTokenValid(surface, token, {
      bridgeId,
      telegramUserId,
      telegramChatInstance,
    }),
    expired: false,
    surface,
  };
}

function maybeBindLaunchTokenChatInstance(
  surface: ReturnType<typeof getCallSurface>,
  chatInstance: string | null,
): ReturnType<typeof getCallSurface> {
  const next = reserveLaunchTokenChatInstance(surface, chatInstance);
  if (next === surface) {
    return surface;
  }
  setCallSurface(next);
  return next;
}

function miniAppContentSecurityPolicy(): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline' https://telegram.org",
    "style-src 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self' https: wss:",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self' https://*.telegram.org",
  ].join("; ");
}

async function teardownCallSurfaceOnGatewayExit(reason: string): Promise<void> {
  const surface = getCallSurface();
  if (!surface.armed && !(surface.tunnelMode === "managed-quick-cloudflared" && surface.tunnelPid)) {
    return;
  }
  if (surface.tunnelMode === "managed-quick-cloudflared") {
    await ensureManagedTunnelStopped(config).catch(() => undefined);
  }
  setCallSurface(recordCallSurfaceDisarmReason(disarmCallSurface(surface), reason));
  logger.info("tearing down armed call surface because realtime gateway is exiting", { reason });
}

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store, max-age=0");
  res.setHeader("pragma", "no-cache");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(JSON.stringify(body));
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AbortError";
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (!signal?.aborted) {
    return;
  }
  if (signal.reason instanceof Error) {
    throw signal.reason;
  }
  throw abortError(message);
}

function releaseLaunchReservationForToken(token: string | null | undefined): void {
  if (!token) {
    return;
  }
  const surface = getCallSurface();
  const next = releaseLaunchTokenReservation(surface, { token });
  if (next !== surface) {
    setCallSurface(next);
  }
}

function hasControlSecret(req: import("node:http").IncomingMessage): boolean {
  return Boolean(env.realtimeControlSecret && req.headers["x-bridge-secret"] === env.realtimeControlSecret);
}

async function readJson(
  req: import("node:http").IncomingMessage,
  maxBytes = 64 * 1024,
  signal?: AbortSignal,
): Promise<any> {
  throwIfAborted(signal, "Request body read cancelled.");
  const chunks: Buffer[] = [];
  let total = 0;
  const bodyPromise = (async () => {
    for await (const chunk of req) {
      throwIfAborted(signal, "Request body read cancelled.");
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        throw new Error("Request body too large.");
      }
      chunks.push(buffer);
    }
    throwIfAborted(signal, "Request body read cancelled.");
    return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
  })();
  if (!signal) {
    return await bodyPromise;
  }
  return await new Promise((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : abortError("Request body read cancelled."));
    };
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    bodyPromise.then(
      value => {
        cleanup();
        resolve(value);
      },
      error => {
        cleanup();
        reject(error);
      },
    );
  });
}

function requireBridge(bridgeId: string): BridgePeer {
  const bridge = bridges.get(bridgeId);
  if (!bridge) {
    throw new Error(`Bridge ${bridgeId} is not connected.`);
  }
  return bridge;
}

async function requestBridgeContext(
  bridgeId: string,
  payload: { callId: string; telegramUserId: string | null; telegramChatInstance: string | null },
  signal?: AbortSignal,
) {
  throwIfAborted(signal, "Bridge context request cancelled.");
  const bridge = requireBridge(bridgeId);
  const id = randomUUID();
  const result = new Promise<any>((resolve, reject) => {
    const timeoutMs = Math.max(10_000, Math.min(config.realtime.startup_timeout_ms, 60_000));
    let sent = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      bridge.pending.delete(id);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      void (async () => {
        if (sent) {
          await notifyBridgeHangup(bridgeId, payload.callId, "prepare_cancelled");
        }
        reject(signal?.reason instanceof Error ? signal.reason : abortError("Bridge context request cancelled."));
      })();
    };
    const timer = setTimeout(() => {
      void (async () => {
        cleanup();
        try {
          await notifyBridgeHangup(bridgeId, payload.callId, "prepare_timeout");
        } finally {
          reject(new Error("Timed out waiting for bridge context."));
        }
      })();
    }, timeoutMs);
    timer.unref?.();
    bridge.pending.set(id, value => {
      cleanup();
      resolve(value);
    });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      bridge.socket.send(JSON.stringify({
        id,
        type: "call.prepare",
        payload: {
          callId: payload.callId,
          bridgeId,
          telegramUserId: payload.telegramUserId,
          telegramChatInstance: payload.telegramChatInstance,
        },
      } satisfies BridgeControlEnvelope));
      sent = true;
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
  return result;
}

async function notifyBridgeHangup(bridgeId: string, callId: string, reason: string): Promise<boolean> {
  const bridge = bridges.get(bridgeId);
  if (!bridge || bridge.socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  return await new Promise(resolve => {
    bridge.socket.send(JSON.stringify({
      type: "call.hangup",
      payload: {
        callId,
        reason,
      },
    } satisfies BridgeControlEnvelope), error => {
      if (error) {
        logger.warn("failed to notify bridge about call hangup", {
          bridgeId,
          callId,
          reason,
          error: error.message,
        });
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
}

function closeBrowserSocket(socket: WebSocket | null, reason: string): void {
  if (!socket) {
    return;
  }
  try {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(4000, reason);
      const forceCloseTimer = setTimeout(() => {
        if (socket.readyState !== WebSocket.CLOSED) {
          socket.terminate();
        }
      }, 1_000);
      forceCloseTimer.unref?.();
      return;
    }
    if (socket.readyState !== WebSocket.CLOSED) {
      socket.terminate();
    }
  } catch {
    // Best-effort cleanup only.
  }
}

function clearCallSession(callId: string): void {
  const session = calls.get(callId);
  if (!session) {
    return;
  }
  const browserSocket = session.browserSocket;
  if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer);
  }
  if (session.startupTimer) {
    clearTimeout(session.startupTimer);
  }
  if (session.maxDurationTimer) {
    clearTimeout(session.maxDurationTimer);
  }
  if (session.finalizeTimer) {
    clearTimeout(session.finalizeTimer);
  }
  session.browserSocket = null;
  session.browserConnected = false;
  session.started = false;
  calls.delete(callId);
  for (const key of [...callSocketAuthFailures.keys()]) {
    if (key.startsWith(`${callId}:`)) {
      callSocketAuthFailures.delete(key);
    }
  }
  closeBrowserSocket(browserSocket, session.endingReason ?? "session_cleared");
}

function callRoot(callId: string): string {
  return join(config.storageRoot, "calls", callId);
}

function gatewayEventPath(callId: string): string {
  return join(callRoot(callId), "gateway-events.ndjson");
}

function recordGatewayEvent(session: CallSession, event: BridgeCallEvent): Promise<void> {
  const line = `${JSON.stringify({ at: new Date(event.at).toISOString(), event })}\n`;
  session.logChain = session.logChain
    .catch(() => undefined)
    .then(async () => {
      await appendFile(session.gatewayEventPath, line);
    })
    .catch(error => {
      logger.warn("failed to persist gateway call event", {
        callId: session.callId,
        eventType: event.type,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  return session.logChain;
}

function logCallLifecycle(
  session: Pick<CallSession, "callId" | "bridgeId">,
  message: string,
  fields?: Record<string, unknown>,
): void {
  logger.info(message, {
    callId: session.callId,
    bridgeId: session.bridgeId,
    ...fields,
  });
}

function forwardBridgeEvent(session: CallSession, event: BridgeCallEvent): void {
  const bridge = bridges.get(session.bridgeId);
  const envelope = {
    type: "call.event",
    payload: {
      callId: session.callId,
      event,
    },
  } satisfies BridgeControlEnvelope;
  if (!bridge || bridge.socket.readyState !== WebSocket.OPEN) {
    const queued = queuedBridgeEvents.get(session.bridgeId) ?? [];
    queued.push(envelope);
    queuedBridgeEvents.set(session.bridgeId, queued.slice(-512));
    return;
  }
  bridge.socket.send(JSON.stringify(envelope));
}

async function emitTerminalEvent(session: CallSession, reason: string): Promise<void> {
  if (session.endedAt) {
    return;
  }
  if (!session.started) {
    releaseLaunchReservationForToken(session.launchToken);
  }
  session.endedAt = Date.now();
  logCallLifecycle(session, "call ended", { reason });
  const event: BridgeCallEvent = {
    type: "call.ended",
    at: session.endedAt,
    reason,
  };
  await recordGatewayEvent(session, event);
  forwardBridgeEvent(session, event);
}

function scheduleFinalizeDeadline(session: CallSession): void {
  if (session.finalizeTimer) {
    clearTimeout(session.finalizeTimer);
  }
  session.finalizeTimer = setTimeout(() => {
    const latest = calls.get(session.callId);
    if (!latest) {
      return;
    }
    void emitTerminalEvent(latest, latest.endingReason ?? "gateway_hangup")
      .finally(() => clearCallSession(latest.callId));
  }, CALL_FINALIZE_GRACE_MS);
}

function scheduleBrowserFinalizeGrace(session: CallSession, reason: string): void {
  if (session.finalizeTimer) {
    clearTimeout(session.finalizeTimer);
  }
  session.finalizeTimer = setTimeout(() => {
    const latest = calls.get(session.callId);
    if (!latest) {
      return;
    }
    void emitTerminalEvent(latest, latest.endingReason ?? reason)
      .finally(() => clearCallSession(latest.callId));
  }, CALL_FINALIZE_GRACE_MS);
}

function requestCallShutdown(session: CallSession, reason: string): void {
  if (session.endingReason) {
    return;
  }
  session.endingReason = reason;
  logCallLifecycle(session, "call shutdown requested", { reason });
  if (session.browserSocket?.readyState === WebSocket.OPEN) {
    session.browserSocket.send(JSON.stringify({
      type: "call.force_end",
      reason,
    }));
    scheduleFinalizeDeadline(session);
    return;
  }
  void emitTerminalEvent(session, reason)
    .finally(() => clearCallSession(session.callId));
}

function recordCallSocketAuthFailure(session: CallSession, req: import("node:http").IncomingMessage, reason: string): boolean {
  const ip = clientIp(req);
  const key = `${session.callId}:${ip}`;
  const result = registerTimedAttempt(
    callSocketAuthFailures,
    key,
    CALL_SOCKET_AUTH_FAILURE_LIMIT,
    CALL_SOCKET_AUTH_FAILURE_WINDOW_MS,
  );
  logger.warn("realtime call websocket auth failed", {
    callId: session.callId,
    bridgeId: session.bridgeId,
    reason,
    failureCount: result.count,
    clientIp: ip,
  });
  if (result.limitReached) {
    requestCallShutdown(session, "call_auth_rate_limited");
  }
  return result.limitReached;
}

function sanitizeFinalizeEvents(input: unknown): BridgeCallEvent[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .filter((entry): entry is BridgeCallEvent => Boolean(entry && typeof entry === "object" && typeof (entry as { type?: unknown }).type === "string"))
    .filter(entry => entry.type !== "call.ended")
    .slice(0, 512);
}

function schedulePreparedCallExpiry(session: CallSession): void {
  const delayMs = Math.max(5_000, session.expiresAt - Date.now());
  session.cleanupTimer = setTimeout(() => {
    if (session.browserConnected) {
      return;
    }
    requestCallShutdown(session, "call_launch_timeout");
  }, delayMs);
}

function scheduleMaxCallDuration(session: CallSession): void {
  if (session.maxDurationTimer) {
    clearTimeout(session.maxDurationTimer);
  }
  session.maxDurationTimer = setTimeout(() => {
    const latest = calls.get(session.callId);
    if (!latest) {
      return;
    }
    requestCallShutdown(latest, "max_call_duration_reached");
  }, session.maxCallMs);
}

function scheduleCallStartTimeout(session: CallSession): void {
  if (session.startupTimer) {
    clearTimeout(session.startupTimer);
  }
  session.startupTimer = setTimeout(() => {
    const latest = calls.get(session.callId);
    if (!latest || latest.started) {
      return;
    }
    requestCallShutdown(latest, "call_start_timeout");
  }, config.realtime.startup_timeout_ms);
}

async function createRealtimeClientSecret(signal?: AbortSignal): Promise<string> {
  if (!env.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is required for realtime calling.");
  }
  const timeoutSignal = AbortSignal.timeout(OPENAI_CLIENT_SECRET_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    signal: combinedSignal,
    headers: {
      Authorization: `Bearer ${env.openaiApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model: config.realtime.model,
        audio: {
          output: { voice: config.realtime.voice },
        },
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI realtime client secret request failed with HTTP ${response.status}.`);
  }
  const payload = await response.json() as { value?: string };
  if (!payload.value) {
    throw new Error("OpenAI realtime client secret response did not include a value.");
  }
  return payload.value;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (req.method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/healthz/details") {
      if (!hasControlSecret(req)) {
        sendJson(res, 401, { error: "Unauthorized." });
        return;
      }
      const surface = getCallSurface();
      sendJson(res, 200, {
        ok: true,
        callSurface: {
          armed: surface.armed,
          expiresAt: surface.expiresAt,
          tunnelMode: surface.tunnelMode,
          tunnelPid: surface.tunnelPid,
          tunnelUrl: surface.tunnelUrl,
          launchTokenReady: !surface.launchTokenTelegramChatInstance && isLaunchTokenValid(surface, surface.launchTokenId, {
            bridgeId: config.realtime.bridge_id,
            telegramUserId: config.telegram.authorized_chat_id,
          }),
        },
        bridges: Array.from(bridges.entries()).map(([bridgeId, bridge]) => ({
          bridgeId,
          mode: bridge.status?.mode ?? null,
          owner: bridge.status?.owner ?? null,
          boundThreadId: bridge.status?.boundThreadId ?? null,
          activeCallId: bridge.status?.activeCallId ?? null,
        })),
        calls: Array.from(calls.values()).map(call => ({
          callId: call.callId,
          bridgeId: call.bridgeId,
          browserConnected: call.browserConnected,
          started: call.started,
          endingReason: call.endingReason,
          ageMs: Math.max(0, Date.now() - call.createdAt),
        })),
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/healthz/miniapp") {
      if (!hasControlSecret(req)) {
        sendJson(res, 401, { error: "Unauthorized." });
        return;
      }
      const bridgeId = url.searchParams.get("bridgeId") ?? config.realtime.bridge_id;
      const launch = url.searchParams.get("launch");
      const status = launchTokenStatus(launch, bridgeId);
      if (!status.ok) {
        sendJson(res, status.expired ? 410 : 404, { error: "Not found" });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        bridgeId,
        launchTokenReady: true,
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/miniapp") {
      const bridgeId = url.searchParams.get("bridgeId") ?? config.realtime.bridge_id;
      const launch = url.searchParams.get("launch");
      const status = launchTokenStatus(launch, bridgeId);
      if (!status.ok) {
        sendJson(res, status.expired ? 410 : 404, { error: "Not found" });
        return;
      }
      if (!consumeRateLimit(miniAppAttemptsByIp, clientIp(req), MINIAPP_RATE_LIMIT_PER_IP, MINIAPP_RATE_LIMIT_WINDOW_MS)
        || !consumeRateLimit(miniAppAttemptsByToken, `${bridgeId}:${launch}`, MINIAPP_RATE_LIMIT_PER_TOKEN, MINIAPP_RATE_LIMIT_WINDOW_MS)
      ) {
        sendJson(res, 429, { error: "Too many launch attempts." });
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("cache-control", "no-store, max-age=0");
      res.setHeader("pragma", "no-cache");
      res.setHeader("referrer-policy", "no-referrer");
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("content-security-policy", miniAppContentSecurityPolicy());
      res.end(renderMiniAppHtml({
        bridgeId,
        bootstrapUrl: "/api/call/bootstrap",
        launchToken: launch!,
        badge: config.branding.realtime_badge,
        callTitle: config.branding.realtime_call_title,
        speakerName: config.branding.realtime_speaker_name,
      }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/call/bootstrap") {
      const requestAbort = createRequestAbortController(req, res);
      let bridgeId = config.realtime.bridge_id;
      let callId: string | null = null;
      let launch = "";
      let launchReservationBound = false;
      let bootstrapRateCommitted = false;
      let prepare: any = null;
      let sessionCreated = false;
      let refundBootstrapRateLimit = (): void => undefined;
      try {
        const body = await readJson(req, 64 * 1024, requestAbort.signal);
        bridgeId = String(body.bridgeId || config.realtime.bridge_id);
        launch = typeof body.launch === "string" ? body.launch : "";
        const launchStatus = launchTokenStatus(launch, bridgeId);
        if (!launchStatus.ok) {
          sendJson(res, launchStatus.expired ? 410 : 404, { error: "Not found" });
          return;
        }
        if (preparedCallCountForBridge(bridgeId) >= 1) {
          sendJson(res, 429, { error: "A live call is already being prepared." });
          return;
        }
        let verified;
        try {
          verified = verifyTelegramInitData(String(body.initData || ""), botToken);
        } catch {
          sendJson(res, 401, { error: "Unauthorized." });
          return;
        }
        if (!verified.userId) {
          logger.warn("realtime bootstrap rejected: missing Telegram user identity", { bridgeId });
          sendJson(res, 401, { error: "Telegram Mini App launch did not include a user identity." });
          return;
        }
        const surfaceBeforeBind = launchStatus.surface;
        const boundSurface = maybeBindLaunchTokenChatInstance(surfaceBeforeBind, verified.chatInstance);
        launchReservationBound = Boolean(
          verified.chatInstance
          && !surfaceBeforeBind.launchTokenTelegramChatInstance
          && boundSurface.launchTokenTelegramChatInstance === verified.chatInstance,
        );
        if (!isLaunchTokenValid(boundSurface, launch, {
          bridgeId,
          telegramUserId: verified.userId,
          telegramChatInstance: verified.chatInstance,
        })) {
          sendJson(res, 404, { error: "Not found" });
          return;
        }
        const rateWindowMs = config.realtime.bootstrap_rate_limit_window_ms;
        const ipKey = clientIp(req);
        const userRateKey = `${bridgeId}:${verified.userId}`;
        const rateTimestamp = Date.now();
        const ipReservation = reserveTimedAttempt(
          bootstrapAttemptsByIp,
          ipKey,
          config.realtime.bootstrap_rate_limit_per_ip,
          rateWindowMs,
          rateTimestamp,
        );
        const bridgeReservation = reserveTimedAttempt(
          bootstrapAttemptsByBridge,
          bridgeId,
          config.realtime.bootstrap_rate_limit_per_bridge,
          rateWindowMs,
          rateTimestamp,
        );
        const userReservation = reserveTimedAttempt(
          bootstrapAttemptsByUser,
          userRateKey,
          config.realtime.bootstrap_rate_limit_per_user,
          rateWindowMs,
          rateTimestamp,
        );
        if (!ipReservation || !bridgeReservation || !userReservation) {
          releaseTimedAttempt(bootstrapAttemptsByUser, userReservation);
          releaseTimedAttempt(bootstrapAttemptsByBridge, bridgeReservation);
          releaseTimedAttempt(bootstrapAttemptsByIp, ipReservation);
          sendJson(res, 429, { error: "Too many bootstrap attempts." });
          return;
        }
        bootstrapRateCommitted = true;
        refundBootstrapRateLimit = (): void => {
          if (!bootstrapRateCommitted) {
            return;
          }
          releaseTimedAttempt(bootstrapAttemptsByUser, userReservation);
          releaseTimedAttempt(bootstrapAttemptsByBridge, bridgeReservation);
          releaseTimedAttempt(bootstrapAttemptsByIp, ipReservation);
          bootstrapRateCommitted = false;
        };
        callId = randomUUID();
        prepare = await requestBridgeContext(bridgeId, {
          callId,
          telegramUserId: verified.userId,
          telegramChatInstance: verified.chatInstance,
        }, requestAbort.signal);
        if (!prepare?.allowed || !prepare?.contextPack || !prepare?.call) {
          refundBootstrapRateLimit();
          logger.warn("realtime bootstrap rejected by bridge", {
            bridgeId,
            callId,
            reason: prepare?.reason ?? "unknown",
          });
          sendJson(res, 409, { error: prepare?.reason ?? "Bridge refused to prepare the call." });
          return;
        }
        throwIfAborted(requestAbort.signal, "Live-call bootstrap cancelled.");
        const ephemeralKey = await createRealtimeClientSecret(requestAbort.signal).catch(async error => {
          refundBootstrapRateLimit();
          await notifyBridgeHangup(bridgeId, callId!, "bootstrap_failed");
          throw error;
        });
        try {
          await mkdir(callRoot(callId), { recursive: true });
          await writeFile(gatewayEventPath(callId), "", { flag: "a" });
        } catch (error) {
          refundBootstrapRateLimit();
          await notifyBridgeHangup(bridgeId, callId, "bootstrap_failed");
          throw error;
        }
        throwIfAborted(requestAbort.signal, "Live-call bootstrap cancelled.");
        const clientToken = randomUUID();
        const session: CallSession = {
          callId,
          bridgeId,
          clientToken,
          launchToken: launch,
          maxCallMs: prepare.maxCallMs ?? config.realtime.max_call_ms,
          userId: verified.userId,
          chatInstance: verified.chatInstance,
          browserSocket: null,
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
          browserConnected: false,
          started: false,
          cleanupTimer: null,
          startupTimer: null,
          maxDurationTimer: null,
          finalizeTimer: null,
          endingReason: null,
          endedAt: null,
          gatewayEventPath: gatewayEventPath(callId),
          logChain: Promise.resolve(),
        };
        calls.set(callId, session);
        sessionCreated = true;
        logCallLifecycle(session, "call prepared", {
          telegramUserId: verified.userId,
        });
        schedulePreparedCallExpiry(session);
        throwIfAborted(requestAbort.signal, "Live-call bootstrap cancelled.");
        const surface = getCallSurface();
        const publicBaseValue = resolvePublicBaseUrl(config, surface)
          ?? `http://${req.headers.host ?? `${config.realtime.gateway_host}:${config.realtime.gateway_port}`}`;
        const publicBase = new URL(publicBaseValue);
        publicBase.protocol = publicBase.protocol === "https:" ? "wss:" : "ws:";
        publicBase.pathname = "/ws/call";
        publicBase.search = `callId=${encodeURIComponent(callId)}`;
        sendJson(res, 200, {
          callId,
          clientToken,
          wsUrl: publicBase.toString(),
          finalizeUrl: "/api/call/finalize",
          ephemeralKey,
          model: config.realtime.model,
          voice: config.realtime.voice,
          transcriptionModel: config.realtime.transcription_model,
          instructions: buildRealtimeInstructions(config, prepare.contextPack),
          maxCallMs: prepare.maxCallMs ?? config.realtime.max_call_ms,
          seedMessages: prepare.contextPack.recentTurns.map((turn: { role: "user" | "assistant"; text: string }) => ({
            role: turn.role,
            text: turn.text,
          })),
          startupTimeoutMs: config.realtime.startup_timeout_ms,
          idleWarningMs: config.realtime.idle_warning_ms,
          idleTimeoutMs: config.realtime.idle_timeout_ms,
        });
        return;
      } catch (error) {
        if (isAbortError(error)) {
          refundBootstrapRateLimit();
          if (sessionCreated && callId) {
            const session = calls.get(callId);
            if (session) {
              requestCallShutdown(session, "bootstrap_cancelled");
            }
          } else {
            if (callId && prepare?.allowed) {
              await notifyBridgeHangup(bridgeId, callId, "bootstrap_cancelled");
            }
            if (launchReservationBound) {
              releaseLaunchReservationForToken(launch);
              launchReservationBound = false;
            }
          }
          logger.info("realtime bootstrap cancelled by client", {
            bridgeId,
            callId,
            error: error.message,
          });
          return;
        }
        if (callId && !sessionCreated && !prepare) {
          refundBootstrapRateLimit();
          logger.warn("realtime bootstrap failed while preparing bridge context", {
            bridgeId,
            callId,
            error: error instanceof Error ? error.message : String(error),
          });
          sendJson(res, 504, { error: "Timed out preparing the bound Codex session for a live call." });
          return;
        }
        if (callId && !sessionCreated && prepare) {
          refundBootstrapRateLimit();
          await notifyBridgeHangup(bridgeId, callId, "bootstrap_failed").catch(() => undefined);
          if (launchReservationBound) {
            releaseLaunchReservationForToken(launch);
            launchReservationBound = false;
          }
        }
        throw error;
      } finally {
        requestAbort.cleanup();
      }
    }
    if (req.method === "POST" && url.pathname === "/api/call/hangup") {
      if (!hasControlSecret(req)) {
        sendJson(res, 401, { error: "Unauthorized." });
        return;
      }
      const body = await readJson(req);
      const callId = String(body.callId || "");
      const reason = String(body.reason || "gateway_hangup");
      const session = calls.get(callId);
      if (!session) {
        sendJson(res, 404, { error: "Unknown call." });
        return;
      }
      logCallLifecycle(session, "hangup requested via gateway api", { reason });
      requestCallShutdown(session, reason);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/call/finalize") {
      const body = await readJson(req, 256 * 1024);
      const callId = String(body.callId || "");
      const token = String(body.token || "");
      const reason = String(body.reason || "user_hangup");
      const session = calls.get(callId);
      if (!callId || !token) {
        sendJson(res, 400, { error: "callId and token are required." });
        return;
      }
      if (!session || session.clientToken !== token) {
        sendJson(res, 200, { ok: true, stale: true });
        return;
      }
      const events = sanitizeFinalizeEvents(body.events);
      if (session.finalizeTimer) {
        clearTimeout(session.finalizeTimer);
        session.finalizeTimer = null;
      }
      logCallLifecycle(session, "call finalize received", {
        reason,
        eventCount: events.length,
      });
      for (const event of events) {
        await recordGatewayEvent(session, event);
      }
      await emitTerminalEvent(session, reason);
      clearCallSession(session.callId);
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    logger.error("gateway request failed", {
      error: error instanceof Error ? error.message : String(error),
      method: req.method,
      url: req.url ?? null,
    });
    sendJson(res, 500, { error: "Gateway request failed." });
  }
});

const bridgeWss = new WebSocketServer({ noServer: true });
const callWss = new WebSocketServer({
  noServer: true,
  maxPayload: CALL_SOCKET_MAX_PAYLOAD_BYTES,
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  if (url.pathname === "/ws/bridge") {
    bridgeWss.handleUpgrade(req, socket, head, ws => {
      bridgeWss.emit("connection", ws, req);
    });
    return;
  }
  if (url.pathname === "/ws/call") {
    callWss.handleUpgrade(req, socket, head, ws => {
      callWss.emit("connection", ws, req);
    });
    return;
  }
  socket.destroy();
});

bridgeWss.on("connection", (socket, req) => {
  const bridgeId = String(req.headers["x-bridge-id"] || "");
  const secret = String(req.headers["x-bridge-secret"] || "");
  if (!bridgeId || !env.realtimeControlSecret || secret !== env.realtimeControlSecret) {
    socket.close(4001, "unauthorized");
    return;
  }
  const previous = bridges.get(bridgeId);
  if (previous?.socket.readyState === WebSocket.OPEN) {
    previous.socket.close(4008, "replaced");
  }
  const peer: BridgePeer = {
    socket,
    status: null,
    pending: new Map(),
  };
  bridges.set(bridgeId, peer);
  logger.info("bridge connected to realtime gateway", { bridgeId });
  const queued = queuedBridgeEvents.get(bridgeId);
  if (queued && queued.length > 0) {
    for (const envelope of queued) {
      socket.send(JSON.stringify(envelope));
    }
    queuedBridgeEvents.delete(bridgeId);
  }
  socket.on("message", data => {
    try {
      const parsed = JSON.parse(String(data)) as BridgeControlEnvelope;
      if (parsed.type === "bridge.hello" || parsed.type === "bridge.status") {
        peer.status = parsed.payload;
        return;
      }
      if ("replyTo" in parsed) {
        const resolver = peer.pending.get(parsed.replyTo);
        if (!resolver) {
          return;
        }
        peer.pending.delete(parsed.replyTo);
        resolver((parsed as any).payload);
        return;
      }
      if (parsed.type === "call.hangup") {
        const session = calls.get(parsed.payload.callId);
        if (session?.browserSocket?.readyState === WebSocket.OPEN) {
          session.browserSocket.send(JSON.stringify({ type: "call.force_end", reason: parsed.payload.reason }));
        }
      }
    } catch (error) {
      logger.warn("failed to parse bridge websocket message", {
        error: error instanceof Error ? error.message : String(error),
        bridgeId,
      });
    }
  });
  socket.on("close", () => {
    if (bridges.get(bridgeId) === peer) {
      bridges.delete(bridgeId);
    }
    logger.info("bridge disconnected from realtime gateway", { bridgeId });
  });
});

callWss.on("connection", (socket, req) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const callId = url.searchParams.get("callId");
  const session = callId ? calls.get(callId) : null;
  if (!callId || !session) {
    socket.close(4004, "unknown_call");
    return;
  }
  let authenticated = false;
  const authTimer = setTimeout(() => {
    if (!authenticated) {
      recordCallSocketAuthFailure(session, req, "auth_timeout");
      socket.close(4001, "auth_timeout");
    }
  }, CALL_SOCKET_AUTH_TIMEOUT_MS);

  socket.on("message", data => {
    try {
      const parsed = JSON.parse(String(data)) as
        | { type: "call.auth"; token?: string }
        | { type: "call.event"; event: unknown };
      if (!authenticated) {
        if (parsed.type !== "call.auth" || !parsed.token || parsed.token !== session.clientToken) {
          const limited = recordCallSocketAuthFailure(session, req, "unauthorized");
          socket.close(limited ? 4008 : 4001, limited ? "rate_limited" : "unauthorized");
          return;
        }
        if (session.endingReason || session.endedAt) {
          socket.close(4006, "call_ending");
          return;
        }
        if (session.browserSocket?.readyState === WebSocket.OPEN) {
          socket.close(4009, "call_already_connected");
          return;
        }
        authenticated = true;
        clearTimeout(authTimer);
        callSocketAuthFailures.delete(`${session.callId}:${clientIp(req)}`);
        if (session.finalizeTimer) {
          clearTimeout(session.finalizeTimer);
          session.finalizeTimer = null;
        }
        if (session.cleanupTimer) {
          clearTimeout(session.cleanupTimer);
          session.cleanupTimer = null;
        }
        session.browserConnected = true;
        session.browserSocket = socket;
        logCallLifecycle(session, "call browser connected");
        if (!session.maxDurationTimer) {
          scheduleMaxCallDuration(session);
        }
        scheduleCallStartTimeout(session);
        socket.send(JSON.stringify({ type: "call.auth.ok" }));
        return;
      }
      if (parsed.type !== "call.event") {
        return;
      }
      const event = parsed.event as Partial<BridgeCallEvent> & { type?: string };
      if (session.endingReason) {
        return;
      }
        if (event.type === "call.started") {
          session.started = true;
          if (session.startupTimer) {
            clearTimeout(session.startupTimer);
            session.startupTimer = null;
          }
          const surface = getCallSurface();
          if (surface.launchTokenId === session.launchToken) {
            setCallSurface(invalidateLaunchToken(surface));
          }
          logCallLifecycle(session, "call started");
        }
      recordGatewayEvent(session, parsed.event as BridgeCallEvent);
      forwardBridgeEvent(session, parsed.event as BridgeCallEvent);
    } catch (error) {
      if (!authenticated) {
        const limited = recordCallSocketAuthFailure(session, req, "invalid_json");
        socket.close(limited ? 4008 : 4007, limited ? "rate_limited" : "bad_message");
        return;
      }
      logger.warn("failed to parse browser websocket message", {
        error: error instanceof Error ? error.message : String(error),
        callId,
      });
    }
  });
  socket.on("close", () => {
    clearTimeout(authTimer);
    if (!authenticated) {
      return;
    }
    if (calls.get(session.callId) !== session || session.browserSocket !== socket) {
      return;
    }
    session.browserSocket = null;
    session.browserConnected = false;
    logCallLifecycle(session, "call browser disconnected", {
      reason: session.endingReason ?? "browser_disconnect",
    });
    scheduleBrowserFinalizeGrace(session, session.endingReason ?? "browser_disconnect");
  });
});

server.on("error", error => {
  logger.error("realtime gateway server error", {
    error: error instanceof Error ? error.message : String(error),
    host: config.realtime.gateway_host,
    port: config.realtime.gateway_port,
  });
  void teardownCallSurfaceOnGatewayExit("server_error");
  setImmediate(() => {
    process.exit(1);
  });
});

process.on("SIGINT", () => {
  void teardownCallSurfaceOnGatewayExit("SIGINT").finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void teardownCallSurfaceOnGatewayExit("SIGTERM").finally(() => process.exit(0));
});

process.on("uncaughtException", error => {
  logger.error("realtime gateway uncaught exception", {
    error: error instanceof Error ? error.message : String(error),
  });
  void teardownCallSurfaceOnGatewayExit("uncaughtException").finally(() => process.exit(1));
});

process.on("unhandledRejection", reason => {
  logger.error("realtime gateway unhandled rejection", {
    error: reason instanceof Error ? reason.message : String(reason),
  });
  void teardownCallSurfaceOnGatewayExit("unhandledRejection").finally(() => process.exit(1));
});

server.listen(config.realtime.gateway_port, config.realtime.gateway_host, () => {
  logger.info("realtime gateway listening", {
    host: config.realtime.gateway_host,
    port: config.realtime.gateway_port,
  });
});
