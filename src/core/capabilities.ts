import type { BridgeConfig, BridgeEnv } from "./config.js";
import { maskIdentifier } from "./redaction.js";
import { describeRealtimeBudget, getRealtimeBudgetSnapshot } from "./realtime/budget.js";
import {
  getManagedTunnelRecoveryCooldown,
  managedTunnelRecoveryCooldownDetail,
} from "./realtime/tunnel-cooldown.js";
import { BridgeState } from "./state.js";
import { telegramImageGenerationMode } from "./telegram/image-generation-mode.js";
import { getTerminalBackendOverride, selectedTerminalBackend, terminalCodexIdentity } from "./terminal/codex-terminal.js";
import { SHADOW_WINDOW_NOTICE } from "./types.js";
import type { BoundThread, BridgeMode, BridgeOwner, Modality, ProviderId, ProviderStatus } from "./types.js";

export interface BridgeCapabilityRuntime {
  mode: BridgeMode;
  owner: BridgeOwner;
  binding: BoundThread | null;
  threadId: string | null;
  cwd: string | null;
  daemonRunning: boolean;
  daemonIssue?: string | null;
  gatewayReady: boolean;
  gatewayBridgeReady: boolean;
  realtimePublicReady?: boolean;
  realtimePublicDetail?: string | null;
  launchTokenReady?: boolean;
  realtimeStartBlocker?: string | null;
}

export interface BridgeCapabilitySnapshot {
  runtime: BridgeCapabilityRuntime;
  chains: Record<Modality, ProviderId[]>;
  providerStatuses: Record<Modality, ProviderStatus[]>;
}

export interface RenderCapabilityOptions {
  audience?: "operator" | "telegram";
}

function providerMap(entries: ProviderStatus[]): Map<ProviderId, ProviderStatus> {
  return new Map(entries.map(entry => [entry.id, entry]));
}

function firstAvailable(chain: ProviderId[], statuses: ProviderStatus[]): ProviderStatus | null {
  const byId = providerMap(statuses);
  for (const id of chain) {
    const status = byId.get(id);
    if (status?.available) {
      return status;
    }
  }
  return null;
}

function unavailableReason(chain: ProviderId[], statuses: ProviderStatus[]): string {
  const byId = providerMap(statuses);
  return chain
    .map(id => {
      const status = byId.get(id);
      return status ? `${id}: ${status.detail}` : `${id}: not configured`;
    })
    .join(" | ");
}

function answeringPath(mode: BridgeMode, binding: BoundThread | null): string {
  switch (mode) {
    case "shared-thread-resume":
      return binding
        ? "Bound desktop Codex thread (same-session replies, including web/file/tool use)"
        : "Shared-session mode selected, but no desktop thread is attached yet";
    case "autonomous-thread":
      return "Bridge-owned Codex thread (autonomous bridge session)";
    case "shadow-window":
      return binding
        ? "Desktop Codex window automation on the bound thread (experimental, macOS-only, non-core)"
        : "Shadow-window mode selected, but no desktop thread is attached yet";
  }
}

function realtimeCapabilityDetail(
  config: BridgeConfig,
  state: BridgeState,
  runtime: BridgeCapabilityRuntime,
  audience: "operator" | "telegram",
): string {
  const surface = state.getCallSurface(config.realtime.tunnel_mode);
  if (!config.realtime.enabled) {
    return audience === "telegram" ? "not enabled right now" : "disabled in bridge.config.toml";
  }
  if (!runtime.daemonRunning) {
    return audience === "telegram"
      ? "not available right now"
      : runtime.daemonIssue || "telegram daemon is not running";
  }
  if (config.realtime.tunnel_mode === "managed-quick-cloudflared") {
    const cooldown = getManagedTunnelRecoveryCooldown(state);
    if (cooldown) {
      const remainingSeconds = Math.max(1, Math.ceil((cooldown.until - Date.now()) / 1000));
      return audience === "telegram"
        ? `temporarily cooling down after live-call tunnel failure; try again in ${remainingSeconds}s`
        : managedTunnelRecoveryCooldownDetail(cooldown);
    }
  }
  if (audience === "operator" && !surface.armed) {
    return "disarmed until the bound session runs `bridgectl call arm`";
  }
  if (!runtime.gatewayReady) {
    return audience === "telegram" ? "not available right now" : "gateway is not healthy";
  }
  if (!runtime.gatewayBridgeReady) {
    return audience === "telegram"
      ? "not available right now"
      : "gateway is healthy, but the local bridge control channel is not connected";
  }
  if (audience === "operator" && runtime.realtimePublicReady === false) {
    return runtime.realtimePublicDetail || "public Mini App origin is unreachable";
  }
  if (runtime.owner !== "telegram") {
    return audience === "telegram"
      ? "not available in this chat right now"
      : `available after owner switches back to telegram (current owner: ${runtime.owner})`;
  }
  if (!runtime.binding) {
    return audience === "telegram"
      ? "not available until the assistant is connected"
      : "available after a desktop thread is attached";
  }
  if (audience === "telegram" && !surface.armed) {
    return "available; say 'call me' or send /call to start";
  }
  if (audience === "telegram" && runtime.realtimePublicReady === false) {
    return "not available right now";
  }
  if (runtime.realtimeStartBlocker) {
    return audience === "telegram" ? "queued behind current work" : `currently blocked (${runtime.realtimeStartBlocker})`;
  }
  if (runtime.launchTokenReady === false) {
    return audience === "telegram"
      ? "available; say 'call me' or send /call to refresh the invite"
      : "launch token is not currently reusable; run `bridgectl call arm` to mint a fresh invite";
  }
  const budget = getRealtimeBudgetSnapshot(config, state);
  return audience === "telegram"
    ? "ready"
    : `ready (${Math.round(config.realtime.max_call_ms / 1000)}s per call, ${Math.round(config.realtime.max_daily_call_ms / 1000)}s daily; ${describeRealtimeBudget(budget)})`;
}

function telegramTerminalLaneDetail(config: BridgeConfig): string {
  if (!config.terminal_lane.enabled) {
    return "not enabled; ask the local Codex setup agent about the safe tmux lane if you need extra terminal capacity";
  }
  if (
    config.terminal_lane.backend === "tmux"
    && config.terminal_lane.daemon_owned
    && config.terminal_lane.profile === "public-safe"
    && config.terminal_lane.sandbox === "read-only"
    && config.terminal_lane.approval_policy === "never"
  ) {
    return "configured for explicit /terminal use through the safe tmux lane";
  }
  return "configured for explicit /terminal use with terminal gates enabled";
}

function fallbackLaneDetail(config: BridgeConfig): string {
  const fallback = config.bridge.fallback_lane;
  if (!fallback?.enabled) {
    return "disabled; use /fallback enable or [bridge.fallback_lane] after base setup if you want safe desktop-busy capacity";
  }
  return fallback.allow_workspace_writes
    ? "enabled with workspace writes allowed by config; use only after an explicit operator tradeoff"
    : "enabled for safe non-mutating work while the bound desktop turn is busy";
}

function operatorTerminalLaneLines(config: BridgeConfig, state: BridgeState): string[] {
  const lane = config.terminal_lane;
  const override = getTerminalBackendOverride(state);
  const selected = selectedTerminalBackend(config, state);
  const identity = terminalCodexIdentity(state);
  const bridgeOwnedTmuxSelected = selected === "tmux" || selected === "auto";
  const terminalLaneState = lane.enabled ? "enabled" : "disabled";
  const lockedState = identity ? `yes (${identity.backend})` : "none";
  const selectedDetail = override && override !== selected ? `${selected} (override=${override})` : selected;
  const safeTmuxLine = lane.enabled && bridgeOwnedTmuxSelected && lane.daemon_owned
    ? "Safe tmux lane: enabled; requires tmux on PATH, then run `npm run bridge:ctl -- terminal init`; init/status prints the attach command."
    : lane.enabled
      ? "Safe tmux lane: not the selected path; user-owned or non-tmux backends require the explicit gates below."
      : "Safe tmux lane: disabled; set terminal_lane.enabled = true, install tmux, then run `npm run bridge:ctl -- terminal init`.";
  const superpowersLine = lane.profile === "power-user" || lane.sandbox === "workspace-write" || lane.approval_policy === "on-request"
    ? "Terminal superpowers: enabled by config; keep approvals on-request for write-capable work."
    : "Terminal superpowers: locked; run `npm run bridge:ctl -- terminal unlock-superpowers` for the explicit config gates.";

  return [
    "Optional terminal lane",
    `Terminal lane: ${terminalLaneState} (profile=${lane.profile}, sandbox=${lane.sandbox}, approvals=${lane.approval_policy})`,
    `Terminal model: ${lane.model?.trim() || config.codex.model.trim() || "default"}${lane.reasoning_effort ? ` (${lane.reasoning_effort} reasoning)` : ""}; web search enabled at launch`,
    `Selected terminal backend: ${selectedDetail}; locked session: ${lockedState}`,
    safeTmuxLine,
    superpowersLine,
    `User-owned terminals: ${lane.allow_user_owned_sessions ? "enabled" : "disabled"} (${lane.allow_user_owned_sessions ? "iTerm2, Terminal.app, and existing panes can be locked after verification" : "set terminal_lane.allow_user_owned_sessions = true to use iTerm2, Terminal.app, or existing panes"})`,
    `Terminal controls: ${lane.allow_terminal_control ? "enabled" : "disabled"} (${lane.allow_terminal_control ? "interrupt/clear are available after the lane is locked" : "set terminal_lane.allow_terminal_control = true before interrupt/clear"})`,
  ];
}

export function renderCapabilityLines(
  config: BridgeConfig,
  env: BridgeEnv,
  state: BridgeState,
  snapshot: BridgeCapabilitySnapshot,
  options: RenderCapabilityOptions = {},
): string[] {
  const { runtime, chains, providerStatuses } = snapshot;
  const audience = options.audience ?? "operator";
  const asrAvailable = firstAvailable(chains.asr, providerStatuses.asr);
  const ttsAvailable = firstAvailable(chains.tts, providerStatuses.tts);
  const imageAvailable = firstAvailable(chains.image_generation, providerStatuses.image_generation);
  const imageMode = telegramImageGenerationMode(state);
  const nativeImageGenerationReady = imageMode === "codex-native" && Boolean(runtime.binding);

  if (audience === "telegram") {
    return [
      "Capabilities",
      `Answering: ${answeringPath(runtime.mode, runtime.binding)}`,
      "",
      "Ready features",
      "Text chat: ready",
      "Photo input: ready",
      "Documents and PDFs: ready",
      "Video input: ready",
      "Generated images, files, documents, videos, and audio: ready",
      asrAvailable ? "Voice/audio understanding: ready" : "Voice/audio understanding: not available right now",
      ttsAvailable ? "Spoken replies: ready" : "Spoken replies: not available right now",
      imageAvailable || nativeImageGenerationReady ? "Image generation: ready" : "Image generation: not available right now",
      `Live calls: ${realtimeCapabilityDetail(config, state, runtime, audience)}`,
      `Fallback lane: ${fallbackLaneDetail(config)}`,
      `Terminal lane: ${telegramTerminalLaneDetail(config)}`,
      "",
      "Natural usage",
      "Ask normally for images, files, spoken replies, web lookup, or file inspection.",
      "If I am already handling something, new messages wait their turn instead of interrupting the current request.",
      "",
      "Desktop-connected abilities",
      runtime.mode === "shared-thread-resume" || runtime.mode === "shadow-window"
        ? runtime.binding
          ? "This chat can use the connected assistant session for files, tools, and web work."
          : "Connect the assistant session to enable files, tools, and web work."
        : "This chat can use its own assistant session for files, tools, and web work.",
    ];
  }

  const lines = [
    `${config.branding.product_name} capabilities`,
    `Answering path: ${answeringPath(runtime.mode, runtime.binding)}`,
    `Session owner: ${runtime.owner}`,
    `Bound thread: ${runtime.binding?.threadId ?? "(none)"}`,
    `Execution cwd: ${runtime.cwd ?? "(none)"}`,
    "",
    "Base readiness",
    `TELEGRAM_BOT_TOKEN: ${env.telegramBotToken ? "present" : "missing"}`,
    `Authorized chat: ${maskIdentifier(config.telegram.authorized_chat_id)}`,
    `Telegram daemon: ${runtime.daemonRunning ? "running" : runtime.daemonIssue ? `not running (${runtime.daemonIssue})` : "not running"}`,
    runtime.mode === "shared-thread-resume" || runtime.mode === "shadow-window"
      ? runtime.binding
        ? "Desktop thread binding: ready"
        : "Desktop thread binding: missing (run `npm run bridge:claim` from the Codex Desktop session you want Telegram to inherit)"
      : "Desktop thread binding: optional in autonomous-thread mode",
    "",
    "Bridge-managed features",
    "Telegram text: ready",
    "Telegram photo input: ready (photos become localImage inputs to Codex)",
    "Telegram document/file input: ready (text-like files are inlined; PDFs and rich docs get best-effort text extraction when possible; all files are staged locally for follow-up inspection)",
    "Telegram video input: ready (video files get a preview frame plus transcript when possible, and stay staged locally for deeper inspection)",
    "Generated files/documents/videos: ready (when Codex says it created a PDF, report, spreadsheet, markdown, text file, or video under the working directory, the bridge can send it back to Telegram automatically)",
    asrAvailable
      ? `Telegram voice/audio input: ready via ${asrAvailable.id} (${asrAvailable.detail})`
      : `Telegram voice/audio input: unavailable (${unavailableReason(chains.asr, providerStatuses.asr)})`,
    ttsAvailable
      ? `TTS replies: ready via Codex media tools or the /speak shortcut using ${ttsAvailable.id} (${ttsAvailable.detail})`
      : `TTS replies: unavailable (${unavailableReason(chains.tts, providerStatuses.tts)})`,
    imageAvailable
      ? imageMode === "codex-native"
        ? nativeImageGenerationReady
          ? `Image generation: ready via bound Codex native image generation for natural Telegram requests; /image remains available through ${imageAvailable.id} (${imageAvailable.detail})`
          : `Image generation: /image ready through ${imageAvailable.id} (${imageAvailable.detail}); natural Telegram image requests are set to native Codex mode and need a bound desktop thread`
        : `Image generation: ready via natural-language direct image handling, Codex media tools, or the /image shortcut using ${imageAvailable.id} (${imageAvailable.detail})`
      : imageMode === "codex-native"
        ? nativeImageGenerationReady
          ? "Image generation: ready via bound Codex native image generation for natural Telegram requests"
          : "Image generation: native Codex mode is enabled for natural Telegram requests, but a desktop thread must be bound first"
        : `Image generation: unavailable (${unavailableReason(chains.image_generation, providerStatuses.image_generation)})`,
    imageMode === "codex-native"
      ? nativeImageGenerationReady
        ? "Native Codex image generation mode: enabled for natural Telegram image requests."
        : "Native Codex image generation mode: enabled, waiting for a bound desktop thread."
      : "Bridge-direct image generation mode: natural Telegram image requests use the configured bridge image provider when available.",
    `Realtime calls: ${realtimeCapabilityDetail(config, state, runtime, audience)}`,
    `Fallback lane: ${fallbackLaneDetail(config)}`,
    ...operatorTerminalLaneLines(config, state),
    `Experimental mode note: ${SHADOW_WINDOW_NOTICE}`,
    "Natural usage: ask for images, videos, documents, or spoken replies directly in plain English; /image and /speak are optional shortcuts, not required.",
    "Examples: 'inspect this image', 'summarize this file', 'review this video', 'make an image of a fox', 'reply with audio', 'make me a PDF summary and send it back'.",
    "Shared-thread note: the bound desktop session still runs one Codex turn at a time. If it is already answering locally, new Telegram requests stay queued and get an immediate queued placeholder instead of starting a second turn.",
    "",
    "Codex-side abilities",
    runtime.mode === "shared-thread-resume" || runtime.mode === "shadow-window"
      ? runtime.binding
        ? "Repo/file/tool/web capabilities are inherited from the bound desktop Codex session."
        : "Repo/file/tool/web capabilities will be inherited once a desktop Codex thread is attached."
      : "Repo/file/tool/web capabilities come from the bridge-owned Codex thread.",
    "",
    "Provider chains",
    `ASR: ${chains.asr.join(" -> ")}`,
    `TTS: ${chains.tts.join(" -> ")}`,
    `Image: ${chains.image_generation.join(" -> ")}`,
    "",
    "Configured secrets",
    `OPENAI_API_KEY: ${env.openaiApiKey ? "present" : "missing"}`,
    `ELEVENLABS_API_KEY: ${env.elevenlabsApiKey ? "present" : "missing"}`,
    `GOOGLE_GENAI_API_KEY: ${env.googleGenAiApiKey ? "present" : "missing"}`,
    `REALTIME_CONTROL_SECRET: ${env.realtimeControlSecret ? "present" : "missing"}`,
    `Pending approvals: ${state.getPendingApprovalCount()}`,
    `Queued Telegram tasks: ${state.getQueuedTaskCount()}`,
  ];
  return lines;
}
