import { resolve4, resolve6 } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import type { BridgeConfig } from "../config.js";
import type { RealtimeCallSurfaceRecord } from "../types.js";
import { buildSurfaceLaunchUrl, describeLaunchTokenState, resolvePublicBaseUrl } from "./surface.js";

export interface RealtimePublicSurfaceStatus {
  ready: boolean;
  publicUrl: string | null;
  healthUrl: string | null;
  launchUrl: string | null;
  detail: string;
}

interface ProbeOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  dnsFallbackFetchImpl?: typeof fetch;
  extraHeaders?: HeadersInit;
  preferControlMiniAppProbe?: boolean;
}

interface WaitOptions extends ProbeOptions {
  deadlineMs?: number;
  intervalMs?: number;
}

function trimBaseUrl(url: string): string {
  return url.replace(/\/$/, "");
}

function mergeHeaders(...inputs: Array<HeadersInit | undefined>): Headers {
  const headers = new Headers();
  for (const input of inputs) {
    const next = new Headers(input);
    next.forEach((value, key) => {
      headers.set(key, value);
    });
  }
  return headers;
}

function buildMiniAppProbeUrl(launchUrl: string): string {
  const url = new URL(launchUrl);
  url.pathname = "/healthz/miniapp";
  return url.toString();
}

function networkErrorCode(error: unknown): string {
  const cause = error && typeof error === "object" && "cause" in error
    ? (error as { cause?: unknown }).cause
    : null;
  return cause && typeof cause === "object" && "code" in cause
    ? String((cause as { code?: unknown }).code)
    : "";
}

function networkErrorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  switch (networkErrorCode(error)) {
    case "ENOTFOUND":
      return "DNS lookup failed";
    case "ECONNREFUSED":
      return "origin connection was refused";
    case "ETIMEDOUT":
      return "network timed out";
    default:
      return message;
  }
}

async function resolveHostAddresses(hostname: string): Promise<string[]> {
  const ipv4 = await resolve4(hostname).catch(() => []);
  const ipv6 = await resolve6(hostname).catch(() => []);
  return [...ipv4, ...ipv6];
}

async function fetchViaResolvedAddress(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const target = new URL(url);
  const addresses = await resolveHostAddresses(target.hostname);
  if (addresses.length === 0) {
    const error = new Error(`DNS resolve returned no addresses for ${target.hostname}`) as Error & {
      cause?: { code: string };
    };
    error.cause = { code: "ENOTFOUND" };
    throw error;
  }
  const headers = new Headers(init.headers ?? {});
  if (!headers.has("host")) {
    headers.set("host", target.host);
  }
  const requestImpl = target.protocol === "https:" ? httpsRequest : httpRequest;
  return await new Promise<Response>((resolvePromise, rejectPromise) => {
    const request = requestImpl({
      protocol: target.protocol,
      host: addresses[0],
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: init.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      ...(target.protocol === "https:" ? { servername: target.hostname } : {}),
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on("end", () => {
        const responseHeaders: Array<[string, string]> = Object.entries(response.headers).flatMap(([key, value]) => {
          if (value === undefined) {
            return [];
          }
          return Array.isArray(value)
            ? value.map(entry => [key, entry] as [string, string])
            : [[key, value] as [string, string]];
        });
        resolvePromise(new Response(Buffer.concat(chunks), {
          status: response.statusCode ?? 500,
          statusText: response.statusMessage ?? "",
          headers: new Headers(responseHeaders),
        }));
      });
    });
    request.once("error", rejectPromise);
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("network timed out"));
    });
    request.end();
  });
}

async function fetchWithDnsFallback(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  allowBuiltInDnsFallback: boolean,
  dnsFallbackFetchImpl?: typeof fetch,
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    if (networkErrorCode(error) !== "ENOTFOUND") {
      throw error;
    }
    if (dnsFallbackFetchImpl) {
      return await dnsFallbackFetchImpl(url, init);
    }
    if (!allowBuiltInDnsFallback) {
      throw error;
    }
    return await fetchViaResolvedAddress(url, init, timeoutMs);
  }
}

async function expectOkJsonHealth(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  allowBuiltInDnsFallback: boolean,
  dnsFallbackFetchImpl?: typeof fetch,
  extraHeaders?: HeadersInit,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    const response = await fetchWithDnsFallback(url, {
      headers: mergeHeaders(initHeaders(extraHeaders)),
      signal: AbortSignal.timeout(timeoutMs),
    }, fetchImpl, timeoutMs, allowBuiltInDnsFallback, dnsFallbackFetchImpl);
    if (!response.ok) {
      return { ok: false, detail: `public health check returned HTTP ${response.status}` };
    }
    const body = await response.json().catch(() => null) as { ok?: unknown } | null;
    if (body && body.ok === false) {
      return { ok: false, detail: "public health check reported not ready" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: `public origin is unreachable (${networkErrorDetail(error)})` };
  }
}

function initHeaders(extraHeaders?: HeadersInit): Headers {
  return mergeHeaders(extraHeaders);
}

async function expectMiniAppReachable(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  allowBuiltInDnsFallback: boolean,
  expectedBadge: string,
  dnsFallbackFetchImpl?: typeof fetch,
  extraHeaders?: HeadersInit,
  expectHtml = true,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    const response = await fetchWithDnsFallback(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: mergeHeaders(expectHtml ? {
        Accept: "text/html",
      } : {
        Accept: "application/json",
      }, extraHeaders),
    }, fetchImpl, timeoutMs, allowBuiltInDnsFallback, dnsFallbackFetchImpl);
    if (response.status === 404) {
      return { ok: false, detail: "launch token was rejected or already consumed; run `bridgectl call arm` to mint a fresh invite" };
    }
    if (response.status === 410) {
      return { ok: false, detail: "launch token expired; run `bridgectl call arm` to mint a fresh invite" };
    }
    if (!response.ok) {
      return { ok: false, detail: `Mini App returned HTTP ${response.status}` };
    }
    if (!expectHtml) {
      return { ok: true };
    }
    const html = await response.text();
    if (!html.includes(expectedBadge) || !html.includes('id="startBtn"')) {
      return { ok: false, detail: "Mini App returned unexpected content" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: `Mini App is unreachable (${networkErrorDetail(error)})` };
  }
}

export async function probeRealtimePublicSurface(
  config: BridgeConfig,
  surface: RealtimeCallSurfaceRecord,
  options: ProbeOptions = {},
): Promise<RealtimePublicSurfaceStatus> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const dnsFallbackFetchImpl = options.dnsFallbackFetchImpl;
  const extraHeaders = options.extraHeaders;
  const allowBuiltInDnsFallback = options.fetchImpl === undefined && dnsFallbackFetchImpl === undefined;
  const timeoutMs = options.timeoutMs ?? 1_500;
  if (!config.realtime.enabled) {
    return {
      ready: false,
      publicUrl: null,
      healthUrl: null,
      launchUrl: null,
      detail: "realtime is disabled in bridge.config.toml",
    };
  }
  const publicUrl = resolvePublicBaseUrl(config, surface);
  if (!publicUrl) {
    return {
      ready: false,
      publicUrl: null,
      healthUrl: null,
      launchUrl: null,
      detail: surface.tunnelMode === "managed-quick-cloudflared"
        ? "managed tunnel is not armed"
        : "realtime.public_url is not configured",
    };
  }
  const trimmedPublicUrl = trimBaseUrl(publicUrl);
  const healthUrl = `${trimmedPublicUrl}/healthz`;
  const launchUrl = buildSurfaceLaunchUrl(config, surface);
  if (!launchUrl) {
    return {
      ready: false,
      publicUrl: trimmedPublicUrl,
      healthUrl,
      launchUrl: null,
      detail: describeLaunchTokenState(surface),
    };
  }
  const health = await expectOkJsonHealth(
    healthUrl,
    fetchImpl,
    timeoutMs,
    allowBuiltInDnsFallback,
    dnsFallbackFetchImpl,
    extraHeaders,
  );
  if (!health.ok) {
    return {
      ready: false,
      publicUrl: trimmedPublicUrl,
      healthUrl,
      launchUrl,
      detail: health.detail,
    };
  }
  const useControlMiniAppProbe = Boolean(options.preferControlMiniAppProbe && extraHeaders);
  const miniApp = await expectMiniAppReachable(
    useControlMiniAppProbe ? buildMiniAppProbeUrl(launchUrl) : launchUrl,
    fetchImpl,
    timeoutMs,
    allowBuiltInDnsFallback,
    config.branding.realtime_badge,
    dnsFallbackFetchImpl,
    extraHeaders,
    !useControlMiniAppProbe,
  );
  if (!miniApp.ok) {
    return {
      ready: false,
      publicUrl: trimmedPublicUrl,
      healthUrl,
      launchUrl,
      detail: miniApp.detail,
    };
  }
  return {
    ready: true,
    publicUrl: trimmedPublicUrl,
    healthUrl,
    launchUrl,
    detail: "public Mini App is reachable",
  };
}

export async function waitForRealtimePublicSurfaceReady(
  config: BridgeConfig,
  surface: RealtimeCallSurfaceRecord,
  options: WaitOptions = {},
): Promise<RealtimePublicSurfaceStatus> {
  const deadlineMs = options.deadlineMs ?? 20_000;
  const intervalMs = options.intervalMs ?? 500;
  const deadline = Date.now() + deadlineMs;
  let latest = await probeRealtimePublicSurface(config, surface, options);
  while (!latest.ready && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    latest = await probeRealtimePublicSurface(config, surface, options);
  }
  return latest;
}
