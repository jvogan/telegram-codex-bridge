import "dotenv/config";

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, extname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { ArtifactStore } from "../core/artifacts.js";
import { renderCapabilityLines } from "../core/capabilities.js";
import { defaultBridgeMode, loadBridgeEnv, loadConfig, requireTelegramBotToken } from "../core/config.js";
import { type BridgeBackendUnavailableEvent, type CodexTurnInput } from "../core/codex/session.js";
import { BridgeBackendManager } from "../core/codex/manager.js";
import type { JsonRpcRequest } from "../core/codex/protocol.js";
import { RolloutWatcher } from "../core/desktop/rollout-watcher.js";
import { DesktopThreadLocator } from "../core/desktop/thread-locator.js";
import { createLogger } from "../core/logger.js";
import { MediaRegistry } from "../core/media/registry.js";
import {
  describeCallStartBlocker as summarizeCallStartBlocker,
  describeLiveCallPriorityHint,
  formatAgeSeconds,
  formatTimestamp,
  summarizeRecentCallSurfaceEvents,
  summarizeRecentCall,
  summarizeRecentFailedTask,
} from "../core/operator-diagnostics.js";
import { redactUrlForLogs } from "../core/redaction.js";
import { describeRealtimeBudget, formatRealtimeBudgetSeconds, getRealtimeBudgetSnapshot } from "../core/realtime/budget.js";
import {
  buildCallEnableOfferLine,
  describeCallArmBlocker,
  shouldAllowSnapshotBootstrapForExplicitLiveCall,
  shouldIgnoreBlockerForExplicitLiveCall,
  shouldPreemptBlockerForExplicitLiveCall,
  shouldOfferCallEnableRequest,
  shouldSuppressExplicitLiveCallBlocker,
  type CallStartBlocker,
} from "../core/realtime/call-enable.js";
import { detectTelegramCallIntent, type TelegramCallIntent } from "../core/realtime/call-intent.js";
import { buildCallContextPack } from "../core/realtime/context.js";
import { CallStore, ClosedCallMutationError } from "../core/realtime/calls.js";
import { callBlocksAsyncWork, callHoldReason, callNeedsFinalization, isCallLive } from "../core/realtime/finalization.js";
import { RealtimeGatewayClient } from "../core/realtime/gateway-client.js";
import { buildCallInviteText, buildCallLaunchMarkup as buildRealtimeCallLaunchMarkup } from "../core/realtime/invite.js";
import { probeRealtimePublicSurface, type RealtimePublicSurfaceStatus } from "../core/realtime/public-surface.js";
import { planStartupCallSurfaceAction } from "../core/realtime/startup-recovery.js";
import {
  callSurfaceStatusLabel,
  describeLaunchTokenState,
  describeRememberedDisarmedCallSurface,
  disarmCallSurface,
  formatSurfaceExpiry,
  getRealtimeTunnelMode,
  isLaunchTokenValid,
  mintLaunchToken,
  recordCallSurfaceEvent,
  recordCallSurfaceDisarmReason,
  recordPublicSurfaceProbe,
  shouldAutoDisarmSurface,
  shouldFailClosedArmingSurface,
  touchCallSurfaceActivity,
} from "../core/realtime/surface.js";
import { applyManagedTunnelHandle } from "../core/realtime/tunnel-surface.js";
import {
  clearManagedTunnelRecoveryCooldown,
  getManagedTunnelRecoveryCooldown,
  managedTunnelRecoveryCooldownDetail,
  setManagedTunnelRecoveryCooldown,
} from "../core/realtime/tunnel-cooldown.js";
import {
  ensureManagedTunnelStopped,
  readManagedQuickTunnelUrl,
  resolveManagedTunnelPid,
  startManagedQuickTunnel,
} from "../core/realtime/tunnel.js";
import { BridgeState } from "../core/state.js";
import { TelegramClient } from "../core/telegram/client.js";
import { detectTelegramControlIntent, type TelegramControlIntent } from "../core/telegram/control-intent.js";
import {
  detectTelegramTerminalIntent,
  extractTelegramTerminalAskText,
  type TelegramTerminalIntent,
} from "../core/telegram/terminal-intent.js";
import { deliverAudioArtifacts } from "../core/telegram/audio-delivery.js";
import { deliverDocumentArtifacts } from "../core/telegram/document-delivery.js";
import { sanitizeTelegramFinalText } from "../core/telegram/final-text.js";
import {
  selectTelegramTaskLane,
} from "../core/telegram/fallback-routing.js";
import { deliverImageArtifacts } from "../core/telegram/image-delivery.js";
import {
  buildDirectImageGenerationPrompt,
  imageGenerationRequestText,
} from "../core/telegram/image-generation-intent.js";
import { telegramImageGenerationMode } from "../core/telegram/image-generation-mode.js";
import { deliverVideoArtifacts } from "../core/telegram/video-delivery.js";
import {
  collectReferencedGeneratedAudio,
  collectReferencedGeneratedDocuments,
  collectReferencedGeneratedImages,
  collectReferencedGeneratedVideos,
  collectRecentGeneratedImages,
  mimeTypeForGeneratedAudio,
  mimeTypeForGeneratedDocument,
  mimeTypeForGeneratedVideo,
} from "../core/telegram/generated-files.js";
import { extractMarkdownImageReferences } from "../core/telegram/markdown-images.js";
import {
  telegramProgressText,
  telegramTurnStartText,
  telegramTurnSubmittedText,
} from "../core/telegram/progress-text.js";
import {
  buildQueuedPlaceholder,
  describeTelegramQueueHoldReason,
} from "../core/telegram/queue-status.js";
import { armFastAsrPreference, clearExpiredFastAsrPreference, consumeFastAsrPreference } from "../core/telegram/fast-asr-state.js";
import {
  buildTelegramTask,
  buildTelegramTurnInputs,
  classifyTelegramTurnWorkload,
  documentDownloadPathForTask,
  imageDownloadPathForTask,
  MAX_AUDIO_INPUT_BYTES,
  MAX_DOCUMENT_INPUT_BYTES,
  MAX_IMAGE_INPUT_BYTES,
  MAX_VIDEO_INPUT_BYTES,
  shouldCarryForwardFastAsrPreference,
  TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
  validateTelegramTaskForProcessing,
} from "../core/telegram/tasks.js";
import { parseTelegramSlashCommand } from "../core/telegram/slash-command.js";
import { sideEffectfulSlashCommandCategory } from "../core/telegram/side-effectful-updates.js";
import {
  buildTerminalConversationPromptForTask,
  buildTerminalPromptForTask,
  buildTerminalPromptForText,
  isTerminalUnsafeRequest,
  selectTerminalRouteForTask,
  terminalConversationBlocker,
  terminalRouteCanBypassHold,
} from "../core/telegram/terminal-routing.js";
import {
  renderTeleportSuccess,
  renderThreadTeleportList,
  type ThreadTeleportActivity,
} from "../core/telegram/thread-teleport.js";
import type { TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from "../core/telegram/types.js";
import {
  ensureTerminalCodexIdentity,
  getTerminalBackendOverride,
  getTerminalCodexStatus,
  lockTerminalCodexIdentity,
  pingTerminalCodex,
  persistableTerminalCodexAskStart,
  renderTerminalCodexStatus,
  sanitizeTerminalErrorText,
  selectedTerminalBackend,
  sendTerminalCodexControl,
  setTerminalBackendOverride,
  setTerminalCodexIdentity,
  startTerminalCodexAsk,
  startTerminalCodexWorker,
  stopTerminalCodexWorker,
  terminalAttachCommand,
  terminalCodexIdentity,
  waitForTerminalCodexAskCompletion,
  type PersistableTerminalCodexAskStart,
  type TerminalCodexAskStart,
} from "../core/terminal/codex-terminal.js";
import type {
  ActiveCallRecord,
  ActiveTaskRecord,
  BoundThread,
  BridgeLane,
  BridgeMode,
  BridgeOwner,
  CallArtifact,
  CallInboxItem,
  Modality,
  PendingCallHandoffRecord,
  ProviderId,
  QueuedTelegramTask,
  RecentCallSummary,
  RealtimeCallSurfaceEvent,
  RealtimeCallSurfaceRecord,
  StoredArtifact,
  TerminalLaneBackend,
} from "../core/types.js";
import { ensureDir } from "../core/util/files.js";
import { writePidFile, removePidFile, readPidFile, isProcessRunning } from "../core/util/pid.js";
import { TELEGRAM_DAEMON_PROCESS_PATTERN } from "../core/util/process-patterns.js";
import { cleanupStaleCodexAppServer, findRunningProcessByPattern } from "../core/util/process.js";
import { cleanupEmptyTimeoutCallArtifacts, cleanupStorageRoots, rotatePersistentLogFile } from "../core/util/storage-cleanup.js";
import { extractDocumentText, isTextLikeDocument } from "../core/util/document-text.js";
import { extractVideoFrame, transcodeToWav } from "../core/util/ffmpeg.js";
import { inspectableFileModality, mimeTypeForInspectablePath, resolveAllowedImagePath, resolveAllowedInspectablePath } from "../core/util/path-policy.js";
import { notifyDesktop } from "../core/util/notify.js";

const entryDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(entryDir, "../..");
process.env.BRIDGE_CONFIG_PATH ??= join(repoRoot, "bridge.config.toml");
process.title = "telegram-codex-bridge-daemon";

const logger = createLogger("telegram-daemon");
const config = loadConfig();
const env = loadBridgeEnv(config);
const state = new BridgeState(config.storageRoot);
clearExpiredFastAsrPreference(state);
const recoveredActiveTask = state.recoverInterruptedWork();
const recoveredPendingUserInputs = state.recoverPendingUserInputDiagnostics("daemon restarted before the user-input reply could be processed");
if (recoveredPendingUserInputs > 0) {
  logger.warn("marked pending user-input diagnostics as recovered failed after daemon restart", {
    recoveredPendingUserInputs,
  });
}

const inboundRoot = ensureDir(join(config.storageRoot, "inbound"));
const normalizedRoot = ensureDir(join(config.storageRoot, "normalized"));
const outboundRoot = ensureDir(join(config.storageRoot, "outbound"));
const pidFilePath = join(config.storageRoot, "telegram-daemon.pid");
const TELEGRAM_PREVIOUS_BOUND_THREAD_KEY = "telegram:previous_bound_thread";
const TERMINAL_ACTIVE_TASK_KEY = "terminal:active_task";
const TELEGRAM_TERMINAL_CHAT_MODE_KEY = "telegram:terminal_chat_mode";

const telegram = new TelegramClient(requireTelegramBotToken(env), logger);
const registry = new MediaRegistry(config, env, state);
const artifacts = new ArtifactStore(config.storageRoot, state);
const codex = new BridgeBackendManager(config, state, logger);
const fallbackCodex = new BridgeBackendManager(config, state, logger, {
  lane: "fallback",
  forcedMode: "autonomous-thread",
});
const locator = new DesktopThreadLocator();
const sharedThreadRolloutWatcher = new RolloutWatcher();
const callStore = new CallStore(config, env, state);
const gatewayClient = new RealtimeGatewayClient(config, env, logger);
const DAEMON_STARTED_AT = Date.now();

let workerRunning = false;
let shutdownRequested = false;
let pollAbortController: AbortController | null = null;
let callSurfaceSweepTimer: NodeJS.Timeout | null = null;
let activeTask: {
  task: QueuedTelegramTask;
  placeholderMessageId: number | null;
  startedAt: number;
  previewText: string | null;
  previewPromise: Promise<void> | null;
} | null = null;
let activeTerminalTask: {
  id: string;
  chatId: string;
  prompt: string;
  placeholderMessageId: number;
  startedAt: number;
  askStart: TerminalCodexAskStart | null;
  source: "command" | "queue";
  queueId: string | null;
} | null = null;
const workerWaiters = new Set<() => void>();
const EXPLICIT_LIVE_CALL_PREEMPT_TIMEOUT_MS = Math.max(30_000, config.realtime.startup_timeout_ms);
const BACKEND_RECOVERY_ATTEMPTS = 3;
const BACKEND_RECOVERY_BACKOFF_MS = 750;
let backendRecoveryPromise: Promise<boolean> | null = null;

interface PersistedTerminalTask {
  id: string;
  chatId: string;
  prompt: string;
  placeholderMessageId: number;
  startedAt: number;
  askStart: PersistableTerminalCodexAskStart | null;
  source: "command" | "queue";
  queueId: string | null;
}

interface PendingApprovalRequest {
  requestId: string | number;
  lane: BridgeLane;
  method: string;
  params: any;
}

interface PendingUserInputQuestionOption {
  label: string;
  description: string;
  isOther?: boolean;
}

interface PendingUserInputQuestion {
  id: string;
  header?: string;
  question: string;
  isOther?: boolean;
  isSecret?: boolean;
  options?: PendingUserInputQuestionOption[];
}

interface PendingUserInputRequest {
  requestId: string | number;
  lane: BridgeLane;
  method: string;
  params: any;
  chatId: string;
  promptMessageId: number;
  questions: PendingUserInputQuestion[];
}

const pendingApprovalRequests = new Map<string, PendingApprovalRequest>();
const pendingUserInputRequests = new Map<string, PendingUserInputRequest>();
const imageStaging = new Map<string, Promise<void>>();
const finalizingCalls = new Set<string>();
const flushingCallHandoffs = new Set<string>();
const pendingCallInboxStages = new Map<string, Set<Promise<unknown>>>();

const CALL_HANDOFF_APPEND_TIMEOUT_MS = 15_000;
const CALL_RECAP_SEND_TIMEOUT_MS = 10_000;
const CALL_CONTEXT_BUILD_TIMEOUT_MS = Math.max(10_000, Math.min(config.realtime.startup_timeout_ms, 20_000));
const CALL_INBOX_STAGE_WAIT_TIMEOUT_MS = 90_000;
const CALL_SURFACE_PUBLIC_WARMUP_TIMEOUT_MS = 60_000;
const CALL_INBOX_STEP_TIMEOUT_MS = 60_000;
const DIRECT_IMAGE_GENERATION_TIMEOUT_MS = 180_000;

function launchTokenReadyForCurrentBridge(surface: RealtimeCallSurfaceRecord): boolean {
  return !surface.launchTokenTelegramChatInstance && isLaunchTokenValid(surface, surface.launchTokenId, {
    bridgeId: config.realtime.bridge_id,
    telegramUserId: config.telegram.authorized_chat_id,
  });
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), timeoutMs);
    timer.unref?.();
    Promise.resolve(operation).then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

interface DynamicToolCallRequestParams {
  callId?: string;
  call_id?: string;
  tool?: string;
  toolName?: string;
  turnId?: string;
  turn_id?: string;
  arguments?: unknown;
  args?: unknown;
  file_path?: string;
  path?: string;
  imageUrl?: string;
  image_url?: string;
  detail?: string;
}

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
};

function getDynamicToolAllowedRoots(backend: BridgeBackendManager = codex): string[] {
  const roots = [backend.getExecutionCwd() ?? process.cwd(), config.storageRoot];
  return [...new Set(roots.map(root => resolve(root)))];
}

function isDynamicToolCallRequest(method: string): boolean {
  return method === "item/tool/call" || method === "dynamicToolCall";
}

function normalizeDynamicToolArguments(params: DynamicToolCallRequestParams): Record<string, unknown> {
  const raw = params.arguments ?? params.args;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  const clone = { ...params };
  delete clone.callId;
  delete clone.call_id;
  delete clone.tool;
  delete clone.toolName;
  delete clone.turnId;
  delete clone.turn_id;
  delete clone.arguments;
  delete clone.args;
  delete clone.detail;
  return clone as Record<string, unknown>;
}

function getDynamicToolCallId(params: DynamicToolCallRequestParams): string | null {
  return params.callId ?? params.call_id ?? null;
}

function getDynamicToolTurnId(params: DynamicToolCallRequestParams): string | null {
  return params.turnId ?? params.turn_id ?? null;
}

function getDynamicToolName(params: DynamicToolCallRequestParams): string | null {
  return params.tool ?? params.toolName ?? null;
}

function mimeTypeForImagePath(path: string): string {
  return IMAGE_MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? "image/png";
}

async function filePathToDataUrl(path: string): Promise<string> {
  const buffer = await readFile(path);
  const mimeType = mimeTypeForImagePath(path);
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

async function openFileOnDesktop(path: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("open", [path], { stdio: "ignore" });
    child.once("error", rejectPromise);
    child.once("close", code => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`open exited with code ${code}`));
    });
  });
}

const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".webp",
]);
const DOCUMENT_EXTENSIONS = new Set([
  ".csv",
  ".doc",
  ".docx",
  ".md",
  ".pdf",
  ".ppt",
  ".pptx",
  ".rtf",
  ".tsv",
  ".txt",
  ".xls",
  ".xlsx",
  ".zip",
]);
const AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".flac",
  ".m4a",
  ".mp3",
  ".mp4",
  ".mpeg",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
  ".webm",
]);
const VIDEO_EXTENSIONS = new Set([
  ".avi",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".webm",
]);

function inspectableKindForPath(path: string): "image" | "document" | "audio" | "video" | null {
  return inspectableFileModality(path);
}

async function inspectLocalFilePath(path: string, backend: BridgeBackendManager = codex): Promise<{
  contentItems: Array<Record<string, unknown>>;
  openPath: string;
  summary: string;
}> {
  const kind = inspectableKindForPath(path);
  if (!kind) {
    throw new Error("Unsupported file type. Allowed file types are images, documents, audio, and video.");
  }

  const allowedPath = await resolveAllowedInspectablePath(path, getDynamicToolAllowedRoots(backend));
  void openFileOnDesktop(allowedPath).catch(error => {
    logger.warn("failed to open inspected file on desktop", {
      path: allowedPath,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  if (kind === "image") {
    return {
      contentItems: [
        {
          type: "inputImage",
          imageUrl: await filePathToDataUrl(allowedPath),
        },
      ],
      openPath: allowedPath,
      summary: "Loaded image into Codex.",
    };
  }

  if (kind === "document") {
    let text = "";
    if (isTextLikeDocument(allowedPath.split("/").pop(), undefined)) {
      text = (await readFile(allowedPath, "utf8")).replace(/\u0000/g, "").trim();
    } else {
      const extracted = await extractDocumentText(allowedPath, allowedPath.split("/").pop(), undefined);
      if (extracted) {
        text = extracted.text;
      }
    }
    return {
      contentItems: [
        {
          type: "inputText",
          text: text
            ? `Loaded document for inspection.\n\n${text}`
            : "Loaded document for inspection. The file was staged locally for follow-up.",
        },
      ],
      openPath: allowedPath,
      summary: "Loaded document into Codex.",
    };
  }

  if (kind === "audio") {
    const normalizedPath = join(config.storageRoot, "dynamic-tool-audio", `${randomUUID()}.wav`);
    await mkdir(dirname(normalizedPath), { recursive: true });
    await transcodeToWav(allowedPath, normalizedPath);
    const transcription = await registry.transcribe({ filePath: normalizedPath });
    return {
      contentItems: [
        {
          type: "inputText",
          text: transcription.text
            ? `Loaded audio for inspection.\n\nTranscript:\n${transcription.text}`
            : "Loaded audio for inspection, but no transcript was produced.",
        },
      ],
      openPath: allowedPath,
      summary: "Loaded audio into Codex.",
    };
  }

  const previewPath = join(config.storageRoot, "dynamic-tool-video", `${randomUUID()}.jpg`);
  const normalizedPath = join(config.storageRoot, "dynamic-tool-video", `${randomUUID()}.wav`);
  await mkdir(dirname(previewPath), { recursive: true });
  await mkdir(dirname(normalizedPath), { recursive: true });
  await extractVideoFrame(allowedPath, previewPath);
  await transcodeToWav(allowedPath, normalizedPath);
  const transcription = await registry.transcribe({ filePath: normalizedPath });
  return {
    contentItems: [
      {
        type: "inputText",
        text: transcription.text
          ? `Loaded video for inspection.\n\nTranscript:\n${transcription.text}`
          : "Loaded video for inspection.",
      },
      {
        type: "inputImage",
        imageUrl: await filePathToDataUrl(previewPath),
      },
    ],
    openPath: allowedPath,
    summary: "Loaded video into Codex.",
  };
}

async function handleDynamicToolCall(
  request: { id: string | number; params?: DynamicToolCallRequestParams },
  backend: BridgeBackendManager = codex,
): Promise<void> {
  const params = request.params ?? {};
  const toolName = getDynamicToolName(params);
  if (!toolName) {
    await backend.respondToServerRequest(request.id, {
      contentItems: [
        {
          type: "inputText",
          text: "Dynamic tool call was missing a tool name.",
        },
      ],
      success: false,
    });
    return;
  }

  if (!["view_image", "view_file", "view_document", "view_audio", "view_video"].includes(toolName)) {
    await backend.respondToServerRequest(request.id, {
      contentItems: [
        {
          type: "inputText",
          text: `Unsupported dynamic tool: ${toolName}`,
        },
      ],
      success: false,
    });
    return;
  }

  const args = normalizeDynamicToolArguments(params);
  const filePath = typeof args.file_path === "string"
    ? args.file_path
    : typeof args.path === "string"
      ? args.path
      : null;
  const imageUrl = typeof args.imageUrl === "string"
    ? args.imageUrl
    : typeof args.image_url === "string"
      ? args.image_url
      : null;

  if (!filePath && !imageUrl) {
    await backend.respondToServerRequest(request.id, {
      contentItems: [
        {
          type: "inputText",
          text: "view_image requires a file_path or imageUrl argument.",
        },
      ],
      success: false,
    });
    return;
  }

  try {
    if (filePath) {
      const candidatePath = filePath.startsWith("/")
        ? filePath
        : resolve(backend.getExecutionCwd() ?? process.cwd(), filePath);
      const inspected = await inspectLocalFilePath(candidatePath, backend);
      await backend.respondToServerRequest(request.id, {
        contentItems: inspected.contentItems,
        success: true,
      });
      return;
    }
    if (!imageUrl?.startsWith("data:image/")) {
      throw new Error("view_image only accepts local file paths or data URLs.");
    }
    await backend.respondToServerRequest(request.id, {
      contentItems: [
        {
          type: "inputImage",
          imageUrl,
        },
      ],
      success: true,
    });
  } catch (error) {
    logger.warn("failed to resolve dynamic file tool call", {
      callId: getDynamicToolCallId(params),
      turnId: getDynamicToolTurnId(params),
      toolName,
      error: error instanceof Error ? error.message : String(error),
    });
    await backend.respondToServerRequest(request.id, {
      contentItems: [
        {
          type: "inputText",
          text: `Failed to load file for ${toolName}: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      success: false,
    });
  }
}

async function preparePersistentLog(path: string, label: string): Promise<void> {
  const rotated = await rotatePersistentLogFile(path).catch(error => {
    logger.warn("failed to rotate persistent log", {
      label,
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
  if (rotated) {
    logger.warn("rotated persistent log before startup", {
      label,
      path,
      archivedPath: rotated.archivedPath,
      bytes: rotated.bytes,
    });
  }
}

function getActiveCall(): ActiveCallRecord | null {
  return state.getActiveCall();
}

function getCallSurface(): RealtimeCallSurfaceRecord {
  return state.getCallSurface(getRealtimeTunnelMode(config));
}

function setCallSurface(surface: RealtimeCallSurfaceRecord): void {
  state.setCallSurface({
    ...surface,
    tunnelMode: getRealtimeTunnelMode(config),
  });
}

function rememberCallSurfaceEvent(
  event: Omit<RealtimeCallSurfaceEvent, "at"> & { at?: number },
  surface = getCallSurface(),
): RealtimeCallSurfaceRecord {
  const next = recordCallSurfaceEvent(surface, {
    ...event,
    at: event.at ?? Date.now(),
  });
  setCallSurface(next);
  return next;
}

function publicSurfaceProbeOptions(timeoutMs?: number): Parameters<typeof probeRealtimePublicSurface>[2] {
  return {
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(env.realtimeControlSecret
      ? { extraHeaders: { "x-bridge-secret": env.realtimeControlSecret } }
      : {}),
    preferControlMiniAppProbe: Boolean(env.realtimeControlSecret),
  };
}

async function syncManagedTunnelSurface(surface = getCallSurface()): Promise<RealtimeCallSurfaceRecord> {
  if (surface.tunnelMode !== "managed-quick-cloudflared") {
    return surface;
  }
  const tunnelPid = await resolveManagedTunnelPid(config);
  const observedUrl = tunnelPid ? await readManagedQuickTunnelUrl(config).catch(() => null) : null;
  const nextUrl = tunnelPid
    ? tunnelPid === surface.tunnelPid
      ? observedUrl ?? surface.tunnelUrl
      : observedUrl
    : null;
  const nextStartedAt = tunnelPid
    ? tunnelPid === surface.tunnelPid
      ? surface.tunnelStartedAt
      : observedUrl
        ? Date.now()
        : null
    : null;
  if (tunnelPid === surface.tunnelPid && nextUrl === surface.tunnelUrl && nextStartedAt === surface.tunnelStartedAt) {
    return surface;
  }
  const next: RealtimeCallSurfaceRecord = {
    ...surface,
    tunnelPid,
    tunnelUrl: nextUrl,
    tunnelStartedAt: nextStartedAt,
  };
  setCallSurface(next);
  return next;
}

async function recoverManagedCallSurface(
  reason: string,
  surface = getCallSurface(),
  options: {
    forceRestart?: boolean;
  } = {},
): Promise<RealtimeCallSurfaceRecord> {
  if (!surface.armed || surface.tunnelMode !== "managed-quick-cloudflared") {
    return surface;
  }
  const cooldown = getManagedTunnelRecoveryCooldown(state);
  if (cooldown) {
    const detail = managedTunnelRecoveryCooldownDetail(cooldown);
    logger.warn("managed live-call tunnel recovery skipped during cooldown", {
      reason,
      detail,
      cooldownUntil: new Date(cooldown.until).toISOString(),
    });
    const next = recordManagedTunnelRecoveryFailure(surface, detail);
    setCallSurface(next);
    return next;
  }
  logger.warn("managed live-call tunnel needs recovery", {
    reason,
    forceRestart: options.forceRestart ?? false,
    tunnelPid: surface.tunnelPid,
    tunnelUrl: surface.tunnelUrl,
  });
  if (options.forceRestart) {
    await ensureManagedTunnelStopped(config).catch(() => undefined);
  }
  const tunnel = await startManagedQuickTunnel(config, logger, surface).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    setManagedTunnelRecoveryCooldown(state, reason, message);
    throw error;
  });
  let next = applyManagedTunnelHandle(config, surface, tunnel, {
    armedByFallback: surface.armedBy ?? "telegram bridge",
  });
  const publicSurface = await waitForPublicCallSurfaceReady(next);
  next = recordPublicSurfaceProbe(next, publicSurface);
  setCallSurface(next);
  if (publicSurface.ready) {
    clearManagedTunnelRecoveryCooldown(state);
  } else {
    setManagedTunnelRecoveryCooldown(state, reason, publicSurface.detail);
  }
  await gatewayClient.sendStatus(gatewayStatusPayload()).catch(() => undefined);
  logger.info("managed live-call tunnel recovered", {
    reason,
    tunnelPid: next.tunnelPid,
    tunnelUrl: next.tunnelUrl,
    publicReady: publicSurface.ready,
    publicDetail: publicSurface.detail,
  });
  return next;
}

function managedTunnelRecoveryFailureDetail(message: string): string {
  return `managed tunnel recovery failed (${message})`;
}

function managedTunnelRecoveryCooldownTelegramLine(): string | null {
  if (getCallSurface().tunnelMode !== "managed-quick-cloudflared") {
    return null;
  }
  const cooldown = getManagedTunnelRecoveryCooldown(state);
  if (!cooldown) {
    return null;
  }
  const remainingSeconds = Math.max(1, Math.ceil((cooldown.until - Date.now()) / 1000));
  const detail = sanitizeTelegramFinalText(cooldown.detail)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
  return `Managed tunnel cooldown: ${remainingSeconds}s remaining after ${cooldown.reason}${detail ? `: ${detail}` : ""}`;
}

function recordManagedTunnelRecoveryFailure(
  surface: RealtimeCallSurfaceRecord,
  message: string,
): RealtimeCallSurfaceRecord {
  return recordPublicSurfaceProbe(surface, {
    ready: false,
    detail: managedTunnelRecoveryFailureDetail(message),
    publicUrl: surface.tunnelUrl,
    healthUrl: surface.tunnelUrl ? `${surface.tunnelUrl.replace(/\/$/, "")}/healthz` : null,
    launchUrl: null,
  });
}

function shouldDisarmAfterManagedTunnelRecoveryFailure(surface: RealtimeCallSurfaceRecord): boolean {
  return Boolean(surface.lastPublicProbeDetail?.startsWith("managed tunnel recovery failed"));
}

function effectiveCallSurfaceStatus(
  surface: RealtimeCallSurfaceRecord,
  publicReady: boolean,
  activeCall = getActiveCall(),
): string {
  return callSurfaceStatusLabel({
    armed: surface.armed,
    publicReady,
    activeCall: Boolean(isCallLive(activeCall)),
    coolingDown: Boolean(surface.armed && !isCallLive(activeCall) && !surface.launchTokenId && surface.expiresAt && surface.expiresAt > Date.now()),
  });
}

function summarizePublicCallIssue(input: {
  surface: RealtimeCallSurfaceRecord;
  gatewayReady?: boolean;
  gatewayConnected: boolean;
  publicSurfaceReady: boolean;
  publicSurfaceDetail: string;
}): string {
  if (!input.surface.armed) {
    return describeRememberedDisarmedCallSurface(input.surface) ?? "call surface is disarmed";
  }
  if (input.gatewayReady === false) {
    return "local realtime gateway is not healthy";
  }
  if (!input.gatewayConnected) {
    return "local realtime gateway control channel is disconnected";
  }
  if (!input.publicSurfaceReady) {
    return input.publicSurfaceDetail;
  }
  return "none";
}

async function disarmCallSurfaceLifecycle(reason: string): Promise<RealtimeCallSurfaceRecord> {
  const current = await syncManagedTunnelSurface();
  if (current.tunnelMode === "managed-quick-cloudflared") {
    await ensureManagedTunnelStopped(config).catch(() => undefined);
  }
  const next = rememberCallSurfaceEvent({
    action: "disarm",
    outcome: "ok",
    source: "bridge lifecycle",
    detail: reason,
  }, recordCallSurfaceDisarmReason(disarmCallSurface(current), reason));
  logger.info("call surface disarmed", { reason });
  return next;
}

function refreshCallSurfaceLaunch(surface: RealtimeCallSurfaceRecord, armedBy: string): RealtimeCallSurfaceRecord {
  if (!surface.armed) {
    throw new Error("Live calling is disarmed. Send `/call enable` first.");
  }
  const now = Date.now();
  const next = mintLaunchToken(config, surface, armedBy, now);
  setCallSurface(next);
  return next;
}

function ensureCallSurfaceCanArm(): void {
  if (!config.realtime.enabled) {
    throw new Error("Realtime calling is disabled in bridge.config.toml.");
  }
  const blocker = describeCallArmBlocker({
    activeCall: getActiveCall(),
    owner: codex.getOwner(),
    binding: state.getBoundThread(),
  });
  if (blocker) {
    throw new Error([blocker.summary, blocker.nextStep].join(" "));
  }
}

async function waitForGatewayBridgeConnection(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (gatewayClient.isConnected()) {
      return;
    }
    await sleep(250);
  }
  throw new Error("The realtime gateway is running, but the local bridge control channel did not connect in time.");
}

async function waitForPublicCallSurfaceReady(
  surface: RealtimeCallSurfaceRecord,
  timeoutMs = 20_000,
): Promise<RealtimePublicSurfaceStatus> {
  const deadline = Date.now() + timeoutMs;
  let currentSurface = surface;
  let last = await probeRealtimePublicSurface(config, currentSurface, publicSurfaceProbeOptions());
  while (Date.now() < deadline) {
    if (last.ready) {
      return last;
    }
    await sleep(500);
    currentSurface = await syncManagedTunnelSurface(currentSurface);
    last = await probeRealtimePublicSurface(config, currentSurface, publicSurfaceProbeOptions());
  }
  return last;
}

async function ensureCallSurfaceArmStillAllowed(
  gatewayReady: boolean,
  gatewayConnected: boolean,
): Promise<void> {
  const blocker = describeCallArmBlocker({
    activeCall: getActiveCall(),
    owner: codex.getOwner(),
    binding: state.getBoundThread(),
    gatewayReady,
    gatewayConnected,
  });
  if (blocker) {
    throw new Error([blocker.summary, blocker.nextStep].join(" "));
  }
}

async function armCallSurfaceFromBridge(armedBy: string): Promise<{
  surface: RealtimeCallSurfaceRecord;
  gatewayReady: boolean;
  gatewayConnected: boolean;
  publicSurface: RealtimePublicSurfaceStatus;
}> {
  ensureCallSurfaceCanArm();
  const gatewayReadyBefore = await isRealtimeGatewayReady();
  if (!gatewayReadyBefore) {
    throw new Error("The realtime gateway is not healthy.");
  }
  if (!gatewayClient.isConnected()) {
    await waitForGatewayBridgeConnection();
  }
  const gatewayReady = await isRealtimeGatewayReady();
  if (!gatewayReady) {
    throw new Error("The realtime gateway is not healthy.");
  }
  const gatewayConnected = gatewayClient.isConnected();
  if (!gatewayConnected) {
    throw new Error("The realtime gateway control channel is not connected.");
  }

  await ensureCallSurfaceArmStillAllowed(gatewayReady, gatewayConnected);
  let surface: RealtimeCallSurfaceRecord = {
    ...await syncManagedTunnelSurface(),
    armed: true,
    armedAt: Date.now(),
    armedBy,
    tunnelMode: getRealtimeTunnelMode(config),
  };
  const priorTunnelPid = surface.tunnelPid;
  if (surface.tunnelMode === "managed-quick-cloudflared") {
    const cooldown = getManagedTunnelRecoveryCooldown(state);
    if (cooldown) {
      throw new Error(managedTunnelRecoveryCooldownDetail(cooldown));
    }
    const tunnel = await startManagedQuickTunnel(config, logger, surface).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      setManagedTunnelRecoveryCooldown(state, "call arm", message);
      throw error;
    });
    clearManagedTunnelRecoveryCooldown(state);
    surface = applyManagedTunnelHandle(config, surface, tunnel, {
      armedByFallback: armedBy,
    });
  } else {
    surface = {
      ...surface,
      tunnelPid: null,
      tunnelUrl: config.realtime.public_url ? config.realtime.public_url.replace(/\/$/, "") : null,
      tunnelStartedAt: null,
    };
  }
  try {
    await ensureCallSurfaceArmStillAllowed(gatewayReady, gatewayConnected);
  } catch (error) {
    if (surface.tunnelMode === "managed-quick-cloudflared" && surface.tunnelPid && surface.tunnelPid !== priorTunnelPid) {
      await ensureManagedTunnelStopped(config).catch(() => undefined);
    }
    throw error;
  }
  surface = mintLaunchToken(config, touchCallSurfaceActivity(config, surface), armedBy);
  setCallSurface(surface);
  await gatewayClient.sendStatus(gatewayStatusPayload()).catch(() => undefined);
  const publicSurface = await waitForPublicCallSurfaceReady(surface);
  surface = recordPublicSurfaceProbe(getCallSurface(), publicSurface);
  surface = rememberCallSurfaceEvent({
    action: "arm",
    outcome: "ok",
    source: armedBy,
    detail: publicSurface.ready
      ? "live-call surface armed and the public Mini App is reachable"
      : `live-call surface armed; public Mini App still warming (${publicSurface.detail})`,
  }, surface);
  return {
    surface,
    gatewayReady,
    gatewayConnected,
    publicSurface,
  };
}

async function reconcileCallSurfaceLifecycle(reason: string): Promise<RealtimeCallSurfaceRecord> {
  const activeCall = getActiveCall();
  let surface = await syncManagedTunnelSurface();
  if (shutdownRequested && surface.armed) {
    return await disarmCallSurfaceLifecycle(`${reason}:shutdown`);
  }
  if (callNeedsFinalization(activeCall)) {
    return surface;
  }
  if (surface.armed && !gatewayClient.isConnected()) {
    return await disarmCallSurfaceLifecycle(`${reason}:gateway_disconnected`);
  }
  if (surface.armed && surface.tunnelMode === "managed-quick-cloudflared" && !surface.tunnelPid) {
    try {
      return await recoverManagedCallSurface(`${reason}:tunnel_missing`, surface);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const shouldDisarm = shouldDisarmAfterManagedTunnelRecoveryFailure(surface);
      logger.warn("failed to recover managed live-call tunnel after pid loss", {
        reason,
        error: message,
      });
      surface = recordManagedTunnelRecoveryFailure(surface, message);
      setCallSurface(surface);
      if (shouldDisarm) {
        return await disarmCallSurfaceLifecycle(`${reason}:tunnel_recovery_failed`);
      }
      return surface;
    }
  }
  if (surface.armed && !isCallLive(activeCall) && gatewayClient.isConnected()) {
    const publicSurface = await probeRealtimePublicSurface(config, surface, publicSurfaceProbeOptions(1_000));
    surface = recordPublicSurfaceProbe(surface, publicSurface);
    setCallSurface(surface);
    if (!publicSurface.ready && shouldFailClosedArmingSurface(surface, Date.now(), CALL_SURFACE_PUBLIC_WARMUP_TIMEOUT_MS)) {
      if (surface.tunnelMode === "managed-quick-cloudflared") {
        try {
          return await recoverManagedCallSurface(`${reason}:public_probe_failed`, surface, {
            forceRestart: true,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const shouldDisarm = shouldDisarmAfterManagedTunnelRecoveryFailure(surface);
          logger.warn("failed to recover managed live-call tunnel after public probe failure", {
            reason,
            error: message,
            detail: publicSurface.detail,
          });
          surface = recordManagedTunnelRecoveryFailure(surface, message);
          setCallSurface(surface);
          if (!shouldDisarm) {
            return surface;
          }
        }
      }
      logger.warn("call surface never became publicly reachable; disarming managed live-call surface", {
        reason,
        detail: publicSurface.detail,
        publicUrl: publicSurface.publicUrl,
        healthUrl: publicSurface.healthUrl,
        launchUrl: publicSurface.launchUrl,
        tunnelMode: surface.tunnelMode,
        tunnelUrl: surface.tunnelUrl,
      });
      return await disarmCallSurfaceLifecycle(`${reason}:public_unreachable`);
    }
  }
  if (shouldAutoDisarmSurface(config, surface)) {
    return await disarmCallSurfaceLifecycle(`${reason}:idle`);
  }
  return surface;
}

async function isRealtimeGatewayReady(timeoutMs = 750): Promise<boolean> {
  try {
    const response = await fetch(`http://${config.realtime.gateway_host}:${config.realtime.gateway_port}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function recoverCallSurfaceOnStartup(): Promise<void> {
  const activeCall = getActiveCall();
  const surface = await syncManagedTunnelSurface();
  const tunnelPresent = surface.tunnelMode === "managed-quick-cloudflared"
    && Boolean(surface.tunnelPid || await resolveManagedTunnelPid(config));
  const action = planStartupCallSurfaceAction({
    activeCall,
    surface,
    tunnelPresent,
  });
  if (action === "preserve_for_finalization") {
    logger.info("preserving armed call surface during startup because a live call still needs finalization", {
      callId: activeCall?.callId ?? null,
    });
    return;
  }
  if (action === "recover_managed_surface") {
    try {
      await recoverManagedCallSurface("startup_recovery", surface, { forceRestart: true });
    } catch (error) {
      logger.warn("failed to recover managed live-call surface during startup", {
        error: error instanceof Error ? error.message : String(error),
      });
      await disarmCallSurfaceLifecycle("startup_recovery_failed");
    }
    return;
  }
  if (action === "disarm_surface") {
    await disarmCallSurfaceLifecycle("startup_recovery");
    return;
  }
  if (action === "cleanup_orphaned_tunnel") {
    await disarmCallSurfaceLifecycle("startup_orphaned_tunnel");
  }
}

function trackCallInboxStage<T>(callId: string, operation: Promise<T>): Promise<T> {
  const pending = pendingCallInboxStages.get(callId) ?? new Set<Promise<unknown>>();
  pending.add(operation);
  pendingCallInboxStages.set(callId, pending);
  return operation.finally(() => {
    const current = pendingCallInboxStages.get(callId);
    if (!current) {
      return;
    }
    current.delete(operation);
    if (current.size === 0) {
      pendingCallInboxStages.delete(callId);
    }
  });
}

async function waitForPendingCallInboxStages(callId: string): Promise<void> {
  while (true) {
    const pending = [...(pendingCallInboxStages.get(callId) ?? [])];
    if (pending.length === 0) {
      return;
    }
    logger.info("waiting for in-call attachment staging to finish before finalizing handoff", {
      callId,
      pendingStages: pending.length,
    });
    await withTimeout(
      Promise.allSettled(pending).then(() => undefined),
      CALL_INBOX_STAGE_WAIT_TIMEOUT_MS,
      `timed out waiting for ${pending.length} in-call attachment stage(s) to settle`,
    );
  }
}

function gatewayStatusPayload() {
  const status = codex.getStatus();
  return {
    bridgeId: config.realtime.bridge_id,
    mode: status.mode,
    owner: status.owner,
    boundThreadId: status.binding?.threadId ?? null,
    cwd: status.cwd,
    activeCallId: getActiveCall()?.callId ?? null,
  };
}

function persistGatewayBridgeConnection(connected: boolean): void {
  state.setGatewayBridgeConnection({
    connected,
    updatedAt: Date.now(),
  });
}

function isAuthorizedMessage(message: TelegramMessage | undefined): boolean {
  return Boolean(
    message
    && message.chat.type === "private"
    && String(message.chat.id) === config.telegram.authorized_chat_id,
  );
}

async function runTelegramPreflight(): Promise<void> {
  const me = await telegram.getMe();
  logger.info("telegram bot authenticated", {
    botId: me.id,
    username: me.username ?? null,
    firstName: me.first_name ?? null,
  });
  const webhookInfo = await telegram.getWebhookInfo();
  if (webhookInfo.url) {
    if (!config.telegram.clear_webhook_on_start) {
      throw new Error(
        `Telegram webhook is configured for this bot (${redactUrlForLogs(webhookInfo.url)}). `
        + "Long polling will not work until it is removed. "
        + "Clear it explicitly with `npm run telegram:discover -- --clear-webhook` "
        + "or set `telegram.clear_webhook_on_start = true` in bridge.config.toml.",
      );
    }
    logger.warn("telegram webhook detected; clearing it because clear_webhook_on_start=true", {
      url: redactUrlForLogs(webhookInfo.url),
      pendingUpdateCount: webhookInfo.pending_update_count,
    });
    await telegram.deleteWebhook(false);
  }
}

function mapProviderAlias(value: string): Modality | null {
  switch (value) {
    case "asr":
      return "asr";
    case "tts":
      return "tts";
    case "image":
    case "image_generation":
      return "image_generation";
    default:
      return null;
  }
}

function parseSlashCommand(text: string): { command: string; args: string[] } | null {
  return parseTelegramSlashCommand(text);
}

function splitForTelegram(text: string, maxChars = 3900): string[] {
  if (text.length <= maxChars) {
    return [text];
  }
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    chunks.push(text.slice(cursor, cursor + maxChars));
    cursor += maxChars;
  }
  return chunks;
}

function summarizeTask(task: QueuedTelegramTask): string {
  if (task.kind === "voice") {
    return "voice message";
  }
  if (task.kind === "audio") {
    return "audio attachment";
  }
  if (task.kind === "video") {
    return task.videoFileName || task.text || "video attachment";
  }
  if (task.kind === "document") {
    return task.documentFileName || task.text || "attached file";
  }
  if (task.kind === "image") {
    return task.text || "attached image";
  }
  return task.text;
}

function describeCallStartBlocker(input: {
  surface: RealtimeCallSurfaceRecord;
  activeCall?: ActiveCallRecord | null;
  gatewayReady?: boolean;
  gatewayConnected?: boolean;
  publicSurface?: RealtimePublicSurfaceStatus;
}): CallStartBlocker | null {
  if (!config.realtime.enabled) {
    return {
      code: "realtime_disabled",
      summary: "Realtime calling is disabled in bridge.config.toml.",
      nextStep: "Enable realtime calling before retrying /call.",
    };
  }
  if (input.gatewayReady === false) {
    return {
      code: "gateway_down",
      summary: "The realtime gateway is not healthy.",
      nextStep: "Repair or restart the gateway, then retry /call.",
    };
  }
  if (input.gatewayConnected === false) {
    return {
      code: "gateway_disconnected",
      summary: "The realtime gateway control channel is not connected.",
      nextStep: "Reconnect the gateway control channel, then retry /call.",
    };
  }
  if (!input.surface.armed) {
    return {
      code: "disarmed",
      summary: "Live calling is disarmed.",
      nextStep: "Send `/call enable` to arm live calling for this bridge, then retry /call.",
    };
  }
  if (input.publicSurface && !input.publicSurface.ready) {
    return {
      code: "public_surface_down",
      summary: `The public Mini App is not reachable (${input.publicSurface.detail}).`,
      nextStep: "Fix the public live-call surface, then retry /call.",
    };
  }
  const activeCall = input.activeCall ?? getActiveCall();
  if (callBlocksAsyncWork(activeCall)) {
    return {
      code: "call_active",
      summary: isCallLive(activeCall)
        ? `A live call is already active (${activeCall?.callId ?? "(unknown call)"}).`
        : `A previous live call is still being finalized (${activeCall?.callId ?? "(unknown call)"}).`,
      nextStep: "Wait for the live call to clear, then retry /call.",
    };
  }
  const activeTaskRecord = state.getActiveTask();
  if (activeTaskRecord) {
    return {
      code: "task_in_flight",
      summary: `A Telegram task is already in flight on the shared Codex thread (${activeTaskRecord.queueId}:${activeTaskRecord.stage}).`,
      nextStep: "Finish the task, then retry /call or check /status for queue state.",
    };
  }
  if (codex.hasActiveTurn()) {
    return {
      code: "codex_busy",
      summary: "Codex is already executing a turn for the shared session.",
      nextStep: "Wait for the current turn to finish, then retry /call.",
    };
  }
  const queuedTasks = state.getQueuedTaskCount();
  if (queuedTasks > 0) {
    return {
      code: "queue_backlog",
      summary: `There ${queuedTasks === 1 ? "is" : "are"} ${queuedTasks} queued Telegram ${queuedTasks === 1 ? "task" : "tasks"}.`,
      nextStep: "Drain the queue first, then retry /call or use /inbox to inspect it.",
    };
  }
  const pendingApprovals = state.getPendingApprovalCount();
  if (pendingApprovals > 0) {
    return {
      code: "pending_approvals",
      summary: `There ${pendingApprovals === 1 ? "is" : "are"} ${pendingApprovals} pending approval${pendingApprovals === 1 ? "" : "s"}.`,
      nextStep: "Resolve the approvals first, then retry /call.",
    };
  }
  const pendingCallHandoffs = state.getPendingCallHandoffCount();
  if (pendingCallHandoffs > 0) {
    return {
      code: "pending_handoff",
      summary: "A previous call handoff is still waiting to be appended into Codex.",
      nextStep: "Let the handoff flush first, then retry /call.",
    };
  }
  if (codex.getOwner() !== "telegram") {
    return {
      code: "owner_not_telegram",
      summary: `The session owner is ${codex.getOwner()}, not telegram.`,
      nextStep: "Switch ownership back to telegram, then retry /call.",
    };
  }
  if (!state.getBoundThread()) {
    return {
      code: "unbound",
      summary: "No desktop Codex thread is attached.",
      nextStep: "Attach a desktop Codex thread, then retry /call.",
    };
  }
  return null;
}

async function inspectCallStartState(): Promise<{
  surface: RealtimeCallSurfaceRecord;
  activeCall: ActiveCallRecord | null;
  gatewayReady: boolean;
  gatewayConnected: boolean;
  publicSurface: RealtimePublicSurfaceStatus;
  blocker: CallStartBlocker | null;
}> {
  const surface = await syncManagedTunnelSurface();
  const activeCall = getActiveCall();
  const gatewayReady = await isRealtimeGatewayReady();
  const gatewayConnected = gatewayClient.isConnected();
  const publicSurface = await probeRealtimePublicSurface(config, surface, publicSurfaceProbeOptions());
  const blocker = await effectiveCallStartBlocker({
    surface,
    activeCall,
    gatewayReady,
    gatewayConnected,
    publicSurface,
  });
  return {
    surface,
    activeCall,
    gatewayReady,
    gatewayConnected,
    publicSurface,
    blocker,
  };
}

function buildCallStartBlockedReplyLines(blocker: CallStartBlocker, options?: {
  desktopNotified?: boolean;
}): string[] {
  const lines = [
    "Live call blocked.",
    blocker.summary,
    blocker.nextStep,
  ];
  if (shouldOfferCallEnableRequest(blocker)) {
    lines.push(buildCallEnableOfferLine());
  } else if (options?.desktopNotified) {
    lines.push("The desktop thread was notified.");
  }
  return lines;
}

async function sendLiveCallInvite(
  chatId: string,
  surface: RealtimeCallSurfaceRecord,
  options: {
    replyToMessageId?: number;
    note?: string;
  } = {},
): Promise<void> {
  const replyMarkup = buildRealtimeCallLaunchMarkup(config, surface);
  if (!replyMarkup) {
    throw new Error("Realtime Mini App launch is not configured.");
  }
  await telegram.sendMessage(
    chatId,
    buildCallInviteText(config, options.note),
    {
      ...(options.replyToMessageId ? { replyToMessageId: options.replyToMessageId } : {}),
      replyMarkup,
    },
  );
}

async function handleTelegramCallEnable(chatId: string, message: TelegramMessage, armedBy: string): Promise<void> {
  const existingSurface = await syncManagedTunnelSurface();
  if (existingSurface.armed) {
    const gatewayReady = await isRealtimeGatewayReady();
    const gatewayConnected = gatewayClient.isConnected();
    const publicSurface = await probeRealtimePublicSurface(config, existingSurface, publicSurfaceProbeOptions());
    const publicCallReady = gatewayReady && gatewayConnected && publicSurface.ready;
    const launchTokenReady = launchTokenReadyForCurrentBridge(existingSurface);
    const publicCallIssue = summarizePublicCallIssue({
      surface: existingSurface,
      gatewayReady,
      gatewayConnected,
      publicSurfaceReady: publicSurface.ready,
      publicSurfaceDetail: publicSurface.detail,
    });
    if (publicCallReady && launchTokenReady) {
      const launchSurface = refreshCallSurfaceLaunch(existingSurface, armedBy);
      const replyMarkup = buildRealtimeCallLaunchMarkup(config, launchSurface);
      await telegram.sendMessage(chatId, [
        "Live calling is already enabled for this bridge.",
        "A fresh Mini App invite is ready below.",
        "Tap the button now, or send /call later to mint another invite.",
      ].join("\n"), {
        replyToMessageId: message.message_id,
        ...(replyMarkup ? { replyMarkup } : {}),
      });
      rememberCallSurfaceEvent({
        action: "arm",
        outcome: "ok",
        source: armedBy,
        detail: "fresh launch token minted on an already-armed surface",
      }, launchSurface);
      return;
    }
  }
  const progress = await telegram.sendMessage(
    chatId,
    existingSurface.armed
      ? "Refreshing the live call invite for this bridge..."
      : "Arming live calling for this bridge...",
    {
      replyToMessageId: message.message_id,
    },
  );
  try {
    const result = await armCallSurfaceFromBridge(armedBy);
    const publicCallReady = result.gatewayReady && result.gatewayConnected && result.publicSurface.ready;
    const publicCallIssue = summarizePublicCallIssue({
      surface: result.surface,
      gatewayReady: result.gatewayReady,
      gatewayConnected: result.gatewayConnected,
      publicSurfaceReady: result.publicSurface.ready,
      publicSurfaceDetail: result.publicSurface.detail,
    });
    const replyMarkup = publicCallReady
      ? buildRealtimeCallLaunchMarkup(config, result.surface)
      : undefined;
    const lines = [
      "Live calling is enabled for this bridge.",
      `Gateway: ${result.gatewayReady ? "ready" : "down"} / ${result.gatewayConnected ? "bridge-connected" : "bridge-disconnected"}`,
      `Public call surface: ${publicCallReady ? "ready" : publicCallIssue}`,
      publicCallReady
        ? "Tap the button below to open the Mini App now, or send /call later."
        : "The live-call surface is still warming up. Retry /call in a moment if needed.",
    ];
    await telegram.editMessageText(chatId, progress.message_id, lines.join("\n"), replyMarkup ? { replyMarkup } : undefined);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    rememberCallSurfaceEvent({
      action: "arm",
      outcome: "error",
      source: armedBy,
      detail: messageText,
    });
    logger.warn("failed to arm live calling from Telegram", {
      chatId,
      error: messageText,
    });
    const surface = await syncManagedTunnelSurface().catch(() => null);
    const reply = surface?.armed
      ? "Live calling was armed, but the public Mini App is still warming up. Retry /call in a moment."
      : `Live call enable failed.\n${messageText}`;
    await telegram.editMessageText(chatId, progress.message_id, reply).catch(async () => {
      await telegram.sendMessage(chatId, reply, {
        replyToMessageId: message.message_id,
      });
    });
  }
}

async function handleTelegramCallLaunch(chatId: string, message: TelegramMessage, armedBy: string): Promise<void> {
  const { surface, blocker } = await inspectExplicitLiveCallStartState(armedBy);
  if (blocker) {
    if (shouldOfferCallEnableRequest(blocker)) {
      const progress = await telegram.sendMessage(
        chatId,
        "Arming live calling and preparing the Mini App...",
        {
          replyToMessageId: message.message_id,
        },
      );
      try {
        const result = await armCallSurfaceFromBridge(armedBy);
        const publicCallReady = result.gatewayReady && result.gatewayConnected && result.publicSurface.ready;
        if (!publicCallReady) {
          rememberCallSurfaceEvent({
            action: "start",
            outcome: "blocked",
            source: armedBy,
            detail: result.publicSurface.detail,
          }, result.surface);
          await telegram.editMessageText(
            chatId,
            progress.message_id,
            [
              "Live calling is enabled, but the public Mini App is still warming up.",
              result.publicSurface.detail,
              "Retry /call in a moment if needed.",
            ].join("\n"),
          );
          return;
        }
        await telegram.editMessageText(
          chatId,
          progress.message_id,
          "Live calling is ready. Tap below to open the Mini App.",
          (() => {
            const replyMarkup = buildRealtimeCallLaunchMarkup(config, result.surface);
            return replyMarkup ? { replyMarkup } : undefined;
          })(),
        );
        rememberCallSurfaceEvent({
          action: "start",
          outcome: "ok",
          source: armedBy,
          detail: "fresh Mini App invite is ready in Telegram",
        }, result.surface);
        return;
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        rememberCallSurfaceEvent({
          action: "start",
          outcome: "error",
          source: armedBy,
          detail: messageText,
        });
        logger.warn("failed to arm live calling from Telegram launch request", {
          chatId,
          error: messageText,
        });
        const current = await inspectExplicitLiveCallStartState(armedBy).catch(() => null);
        if (current?.blocker && !(shouldSuppressExplicitLiveCallBlocker(current.blocker) || shouldOfferCallEnableRequest(current.blocker))) {
          await notifyCallStartBlocked(current.blocker).catch(() => undefined);
        }
        const reply = current?.blocker && !shouldSuppressExplicitLiveCallBlocker(current.blocker)
          ? buildCallStartBlockedReplyLines(current.blocker, {
            desktopNotified: Boolean(
              current?.blocker
              && !(shouldSuppressExplicitLiveCallBlocker(current.blocker) || shouldOfferCallEnableRequest(current.blocker)),
            ),
          }).join("\n")
          : `Live call setup failed.\n${messageText}`;
        await telegram.editMessageText(chatId, progress.message_id, reply).catch(async () => {
          await telegram.sendMessage(chatId, reply, {
            replyToMessageId: message.message_id,
          });
        });
        return;
      }
    }
    if (!shouldOfferCallEnableRequest(blocker)) {
      await notifyCallStartBlocked(blocker);
    }
    rememberCallSurfaceEvent({
      action: "start",
      outcome: "blocked",
      source: armedBy,
      detail: blocker.summary,
    });
    await telegram.sendMessage(chatId, buildCallStartBlockedReplyLines(blocker, {
      desktopNotified: !shouldOfferCallEnableRequest(blocker),
    }).join("\n"), {
      replyToMessageId: message.message_id,
    });
    return;
  }
  const launchSurface = refreshCallSurfaceLaunch(surface, armedBy);
  try {
    await sendLiveCallInvite(chatId, launchSurface);
    rememberCallSurfaceEvent({
      action: "start",
      outcome: "ok",
      source: armedBy,
      detail: "fresh Mini App invite sent to Telegram",
    }, launchSurface);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    rememberCallSurfaceEvent({
      action: "start",
      outcome: "error",
      source: armedBy,
      detail: messageText,
    }, launchSurface);
    throw error;
  }
}

async function handleTelegramCallIntent(message: TelegramMessage, intent: TelegramCallIntent): Promise<void> {
  const chatId = String(message.chat.id);
  if (intent === "status") {
    await sendCallStatus(chatId);
    return;
  }
  await handleTelegramCallLaunch(chatId, message, "telegram natural-language /call");
}

async function waitForExplicitLiveCallTurnClear(timeoutMs = EXPLICIT_LIVE_CALL_PREEMPT_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const activeTaskRecord = state.getActiveTask();
    const localTurnActive = codex.hasActiveTurn();
    const externalTurnId = await currentSharedThreadExternalTurnId();
    if (!activeTaskRecord && !localTurnActive && !externalTurnId) {
      return true;
    }
    await sleep(250);
  }
  return false;
}

async function inspectExplicitLiveCallStartState(reason: string): ReturnType<typeof inspectCallStartState> {
  let current = await inspectCallStartState();
  let timedOutWhilePreempting = false;
  if (current.blocker && shouldPreemptBlockerForExplicitLiveCall(current.blocker)) {
    logger.info("interrupting active turn to prioritize explicit live call", {
      reason,
      blocker: current.blocker.summary,
    });
    await codex.interruptActiveTurn();
    timedOutWhilePreempting = !await waitForExplicitLiveCallTurnClear();
    current = await inspectCallStartState();
  }
  if (current.blocker && shouldIgnoreBlockerForExplicitLiveCall(current.blocker)) {
    return {
      ...current,
      blocker: null,
    };
  }
  if (timedOutWhilePreempting && current.blocker && shouldPreemptBlockerForExplicitLiveCall(current.blocker)) {
    return {
      ...current,
      blocker: {
        ...current.blocker,
        summary: "Live calling is still waiting for the interrupted shared-thread turn to yield.",
        nextStep: "Retry /call in a moment. The bridge is still clearing the interrupted Telegram turn.",
      },
    };
  }
  return current;
}

async function inspectExplicitLiveCallBootstrapState(reason: string): ReturnType<typeof inspectCallStartState> {
  let current = await inspectCallStartState();
  if (current.blocker && shouldPreemptBlockerForExplicitLiveCall(current.blocker)) {
    logger.info("interrupting active turn while preparing explicit live call bootstrap", {
      reason,
      blocker: current.blocker.summary,
    });
    await codex.interruptActiveTurn().catch(() => undefined);
    current = await inspectCallStartState();
  }
  if (!current.blocker) {
    return current;
  }
  const localTurnActive = codex.hasActiveTurn();
  const activeTaskPresent = Boolean(state.getActiveTask());
  const desktopTurnId = current.blocker.code === "codex_busy"
    ? await currentSharedThreadExternalTurnId()
    : null;
  if (shouldAllowSnapshotBootstrapForExplicitLiveCall({
    blocker: current.blocker,
    activeTaskPresent,
    localTurnActive,
    desktopTurnId,
  })) {
    logger.info("continuing explicit live call bootstrap with snapshot context while the shared thread yields", {
      reason,
      blocker: current.blocker.summary,
      activeTaskPresent,
      localTurnActive,
      desktopTurnId,
    });
    return {
      ...current,
      blocker: null,
    };
  }
  return current;
}

function buildTurnStartPlaceholder(mode: BridgeMode): string {
  switch (mode) {
    case "shared-thread-resume":
      return "Delivering to the bound desktop Codex session...";
    case "shadow-window":
      return "Delivering to the bound desktop window...";
    default:
      return telegramTurnStartText();
  }
}

function buildTurnSubmittedPlaceholder(mode: BridgeMode): string {
  switch (mode) {
    case "shared-thread-resume":
      return "The bridge started a Codex turn on the bound desktop session.\nWaiting for that turn to finish.";
    case "shadow-window":
      return "The bridge started a Codex turn in the bound desktop window.\nWaiting for that turn to finish.";
    default:
      return telegramTurnSubmittedText();
  }
}

async function stageImageTask(task: QueuedTelegramTask): Promise<void> {
  if (task.kind !== "image" || task.stagedImagePath || !task.photoFileId) {
    return;
  }
  validateTelegramTaskForProcessing(task);
  const imagePath = imageDownloadPathForTask(task, inboundRoot);
  await telegram.downloadFile(task.photoFileId, imagePath, {
    maxBytes: MAX_IMAGE_INPUT_BYTES,
    timeoutMs: TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
  });
  task.stagedImagePath = imagePath;
  state.replaceTask(task);
}

async function maybeNotifyQueuedTask(task: QueuedTelegramTask, aheadCount: number, holdReason: string | null): Promise<void> {
  const summary = summarizeTask(task).replace(/\s+/g, " ").slice(0, 140);
  const lead = aheadCount > 0
    ? `Queued behind ${aheadCount} earlier task${aheadCount === 1 ? "" : "s"}`
    : "Queued for processing";
  const suffix = describeTelegramQueueHoldReason(holdReason);
  const body = suffix ? `${lead}: ${summary}\nWaiting because ${suffix}.` : `${lead}: ${summary}`;
  await notifyDesktop(config.branding.desktop_notification_title, body);
}

async function notifyCallStartBlocked(blocker: CallStartBlocker): Promise<void> {
  await notifyDesktop(`${config.branding.desktop_notification_title} live call blocked`, `${blocker.summary}\n${blocker.nextStep}`).catch((error: unknown) => {
    logger.warn("failed to show live-call desktop notification", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

async function sendFinalText(chatId: string, placeholderMessageId: number | null, text: string): Promise<void> {
  const rawFinalText = text || "(no final answer)";
  const { cleanedText: rawCleanedText, references } = extractMarkdownImageReferences(rawFinalText);
  const cleanedText = sanitizeTelegramFinalText(rawCleanedText);
  const turnStartedAt = activeTask?.startedAt ?? Date.now();
  const [markdownImageArtifacts, referencedImageArtifacts] = await Promise.all([
    stageInlineMarkdownImages(references),
    stageReferencedGeneratedImages(rawFinalText, turnStartedAt),
  ]);
  const alreadyStagedOriginalPaths = new Set(
    [...markdownImageArtifacts, ...referencedImageArtifacts]
      .map(artifact => typeof artifact.metadata?.originalPath === "string" ? artifact.metadata.originalPath : null)
      .filter((path): path is string => Boolean(path)),
  );
  const recentImageArtifacts = activeTask?.task
    ? await stageRecentGeneratedImagesForVisualTask(activeTask.task, turnStartedAt, alreadyStagedOriginalPaths)
    : [];
  const imageArtifacts = [...markdownImageArtifacts, ...referencedImageArtifacts, ...recentImageArtifacts];
  const bodyText = cleanedText.trim().length > 0
    ? cleanedText
    : imageArtifacts.length > 0
      ? "Attached figures."
      : "(no final answer)";
  const parts = splitForTelegram(bodyText);
  let messageParts = parts;
  if (placeholderMessageId) {
    try {
      await telegram.editMessageText(chatId, placeholderMessageId, parts[0]!);
      messageParts = parts.slice(1);
    } catch (error) {
      logger.warn("failed to edit final placeholder, sending fresh Telegram message instead", {
        chatId,
        placeholderMessageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  for (const part of messageParts) {
    await telegram.sendMessage(chatId, part);
  }
  if (imageArtifacts.length > 0) {
    await deliverImageArtifacts({
      telegram,
      chatId,
      artifacts: imageArtifacts,
      markDelivered: artifactId => state.markArtifactDelivered(artifactId),
      markFailed: (artifactId, error) => state.recordArtifactDeliveryFailure(artifactId, error),
      captionForArtifact: artifact => {
        const altText = typeof artifact.metadata?.altText === "string" ? artifact.metadata.altText.trim() : "";
        return altText.length > 0 ? altText.slice(0, 900) : "Generated image.";
      },
      onPhotoFallback: (artifact, error) => {
        logger.warn("sendPhoto failed for inline Markdown image, falling back to sendDocument", {
          artifactId: artifact.id,
          error: error instanceof Error ? error.message : String(error),
          path: artifact.path,
        });
      },
      onDeliveryFailure: (artifact, error) => {
        logger.warn("failed to deliver inline Markdown image", {
          artifactId: artifact.id,
          error: error instanceof Error ? error.message : String(error),
          path: artifact.path,
        });
      },
    }).catch(async error => {
      logger.warn("failed to deliver final-answer images", {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
      await sendDeliveryFailureNotice(chatId, "generated images");
    });
  }
}

function sanitizeTelegramErrorText(text: string): string {
  return sanitizeTelegramFinalText(text).trim() || "Something went wrong while handling that request.";
}

async function sendDeliveryFailureNotice(chatId: string, label: string): Promise<void> {
  await telegram.sendMessage(chatId, `I created ${label}, but could not attach it here. Please try again.`)
    .catch(error => {
      logger.warn("failed to send delivery failure notice", {
        chatId,
        label,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

async function updateRecoveryMessage(chatId: string, placeholderMessageId: number | null, text: string): Promise<void> {
  if (!placeholderMessageId) {
    await telegram.sendMessage(chatId, text);
    return;
  }
  try {
    await telegram.editMessageText(chatId, placeholderMessageId, text);
  } catch (error) {
    logger.warn("failed to edit recovery placeholder, sending a new message instead", {
      chatId,
      placeholderMessageId,
      error: error instanceof Error ? error.message : String(error),
    });
    await telegram.sendMessage(chatId, text);
  }
}

function updatePersistedActiveTaskPlaceholder(messageId: number): void {
  if (!activeTask) {
    return;
  }
  activeTask.placeholderMessageId = messageId;
  const record = state.getActiveTask();
  if (record) {
    state.setActiveTask({
      ...record,
      placeholderMessageId: messageId,
    });
  }
  state.updateQueueStatus(activeTask.task.id, "processing", {
    placeholderMessageId: messageId,
  });
}

function currentPlaceholderMessageId(taskId: string, fallback: number | null): number | null {
  if (activeTask?.task.id === taskId && activeTask.placeholderMessageId) {
    return activeTask.placeholderMessageId;
  }
  return state.getQueueState(taskId)?.placeholderMessageId ?? fallback;
}

async function sendPreviewText(chatId: string, text: string): Promise<void> {
  const firstChunk = splitForTelegram(text || "(no final answer)")[0] ?? "(no final answer)";
  if (activeTask?.previewText === firstChunk) {
    return;
  }
  if (!activeTask) {
    return;
  }
  if (activeTask.placeholderMessageId) {
    await telegram.editMessageText(chatId, activeTask.placeholderMessageId, firstChunk);
  } else {
    const sent = await telegram.sendMessage(chatId, firstChunk);
    updatePersistedActiveTaskPlaceholder(sent.message_id);
  }
  activeTask.previewText = firstChunk;
}

function enqueuePreviewText(taskId: string, chatId: string, text: string): void {
  if (!activeTask || activeTask.task.id !== taskId) {
    return;
  }
  const prior = activeTask.previewPromise ?? Promise.resolve();
  const chained = prior
    .catch(() => {})
    .then(async () => {
      if (!activeTask || activeTask.task.id !== taskId) {
        return;
      }
      await sendPreviewText(chatId, text);
    })
    .catch((error: unknown) => {
      logger.warn("failed to send early final text preview", {
        taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  const trackedPromise = chained.finally(() => {
    if (activeTask?.task.id === taskId && activeTask.previewPromise === trackedPromise) {
      activeTask.previewPromise = null;
    }
  });
  activeTask.previewPromise = trackedPromise;
}

async function flushPreviewText(taskId: string): Promise<void> {
  const pending = activeTask?.task.id === taskId ? activeTask.previewPromise : null;
  if (pending) {
    await pending;
  }
}

async function syncActiveTaskSubmittedPlaceholder(mode: BridgeMode = codex.getMode()): Promise<void> {
  if (!activeTask) {
    return;
  }
  const submittedText = buildTurnSubmittedPlaceholder(mode);
  if (activeTask.placeholderMessageId) {
    await telegram.editMessageText(activeTask.task.chatId, activeTask.placeholderMessageId, submittedText);
    return;
  }
  const sent = await telegram.sendMessage(activeTask.task.chatId, submittedText);
  updatePersistedActiveTaskPlaceholder(sent.message_id);
}

function wakeWorker(): void {
  for (const resolve of workerWaiters) {
    resolve();
  }
  workerWaiters.clear();
}

async function waitForWorkerWake(timeoutMs = 1_000): Promise<void> {
  if (shutdownRequested) {
    return;
  }
  let resolveWake: (() => void) | null = null;
  await Promise.race([
    new Promise<void>(resolve => {
      resolveWake = resolve;
      workerWaiters.add(resolve);
    }),
    sleep(timeoutMs),
  ]);
  if (resolveWake) {
    workerWaiters.delete(resolveWake);
  }
}

async function reconcileInterruptedWork(active: ActiveTaskRecord | null): Promise<void> {
  if (!active) {
    return;
  }

  try {
    const rolloutWatcher = new RolloutWatcher();
    let inspection: Awaited<ReturnType<RolloutWatcher["inspectTurn"]>> | null = null;

    if (active.rolloutPath) {
      inspection = await rolloutWatcher.inspectTurn(active.rolloutPath, active.startedAt, {
        expectedTurnId: active.turnId,
      }).catch(error => {
        logger.warn("failed to inspect rollout during interrupted-work recovery", {
          queueId: active.queueId,
          rolloutPath: active.rolloutPath,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
    }

    if (inspection?.result) {
      await sendFinalText(active.chatId, active.placeholderMessageId, inspection.result.finalText || "(no final answer)");
      await stageReferencedGeneratedDocuments(active.queueId, inspection.result.finalText || "", active.startedAt);
      await stageReferencedGeneratedVideos(active.queueId, inspection.result.finalText || "", active.startedAt);
      await stageReferencedGeneratedAudio(active.queueId, inspection.result.finalText || "", active.startedAt);
      await maybeSendGeneratedImages(active.chatId, {
        createdAfter: active.startedAt,
        labelOlderAsRecovered: true,
      });
      await maybeSendGeneratedDocuments(active.chatId, {
        createdAfter: active.startedAt,
        labelOlderAsRecovered: true,
      });
      await maybeSendGeneratedVideos(active.chatId, {
        createdAfter: active.startedAt,
        labelOlderAsRecovered: true,
      });
      await maybeSendGeneratedAudio(active.chatId, {
        createdAfter: active.startedAt,
        labelOlderAsRecovered: true,
      });
      state.updateQueueStatus(active.queueId, "completed", {
        placeholderMessageId: active.placeholderMessageId,
        errorText: null,
      });
      return;
    }

    const shouldFailClosed = active.stage !== "preparing" || Boolean(inspection?.hasActivity);
    if (shouldFailClosed) {
      const message = [
        "Bridge restarted after this request had already been handed to Codex.",
        "It was not auto-replayed to avoid duplicate commands or edits.",
        "Check the bound desktop thread and resend only if needed.",
      ].join("\n");
      await updateRecoveryMessage(active.chatId, active.placeholderMessageId, message);
      state.updateQueueStatus(active.queueId, "failed", {
        placeholderMessageId: active.placeholderMessageId,
        errorText: message,
      });
      return;
    }

    state.updateQueueStatus(active.queueId, "pending", {
      placeholderMessageId: active.placeholderMessageId,
      errorText: null,
    });
  } catch (error) {
    const message = [
      "Bridge restarted while recovering a previously in-flight request.",
      "It was not auto-replayed because recovery could not prove that doing so was safe.",
      "Inspect the desktop thread before retrying.",
    ].join("\n");
    logger.error("failed to reconcile interrupted work", {
      queueId: active.queueId,
      error: error instanceof Error ? error.message : String(error),
    });
    state.updateQueueStatus(active.queueId, "failed", {
      placeholderMessageId: active.placeholderMessageId,
      errorText: message,
    });
  } finally {
    state.setActiveTask(null);
  }
}

async function recoverBackendAfterUnavailable(event: BridgeBackendUnavailableEvent): Promise<boolean> {
  if (shutdownRequested) {
    return false;
  }
  if (backendRecoveryPromise) {
    return await backendRecoveryPromise;
  }
  const recovery = (async (): Promise<boolean> => {
    const interruptedTask = state.getActiveTask();
    for (let attempt = 1; attempt <= BACKEND_RECOVERY_ATTEMPTS; attempt += 1) {
      try {
        await codex.sync(true, true);
        logger.info("codex backend recovered after transient unavailability", {
          reason: event.reason,
          detail: event.detail,
          attempt,
        });
        if (interruptedTask && !codex.hasActiveTurn()) {
          await reconcileInterruptedWork(interruptedTask);
        }
        wakeWorker();
        return true;
      } catch (error) {
        logger.warn("codex backend recovery attempt failed", {
          reason: event.reason,
          detail: event.detail,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        if (attempt < BACKEND_RECOVERY_ATTEMPTS) {
          await sleep(BACKEND_RECOVERY_BACKOFF_MS * attempt);
        }
      }
    }
    return false;
  })();
  const trackedRecovery = recovery.finally(() => {
    if (backendRecoveryPromise === trackedRecovery) {
      backendRecoveryPromise = null;
    }
  });
  backendRecoveryPromise = trackedRecovery;
  return await trackedRecovery;
}

function summarizeApproval(method: string, params: any): string {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return [
        "Codex requests command approval.",
        params.command ? `Command: ${params.command}` : null,
        params.cwd ? `CWD: ${params.cwd}` : null,
        params.reason ? `Reason: ${params.reason}` : null,
      ].filter(Boolean).join("\n");
    case "item/fileChange/requestApproval":
      return [
        "Codex requests file-change approval.",
        params.reason ? `Reason: ${params.reason}` : null,
        params.grantRoot ? `Grant root: ${params.grantRoot}` : null,
      ].filter(Boolean).join("\n");
    case "item/permissions/requestApproval":
      return [
        "Codex requests additional permissions.",
        params.reason ? `Reason: ${params.reason}` : null,
        params.permissions ? `Requested: ${JSON.stringify(params.permissions)}` : null,
      ].filter(Boolean).join("\n");
    case "item/tool/requestUserInput":
      return [
        "Codex requests user input.",
        params.reason ? `Reason: ${params.reason}` : null,
        params.question ? `Question: ${params.question}` : null,
        params.questions ? `Questions: ${JSON.stringify(params.questions)}` : null,
      ].filter(Boolean).join("\n");
    default:
      return `Codex sent an unsupported server request: ${method}`;
  }
}

function normalizeUserInputQuestions(params: any): PendingUserInputQuestion[] {
  const rawQuestions = Array.isArray(params.questions)
    ? params.questions
    : params.question
      ? [{ id: "question_1", question: params.question, header: params.reason || "" }]
      : [];
  return rawQuestions
    .map((question: any, index: number) => {
      const options = Array.isArray(question?.options)
        ? question.options
          .map((option: any) => ({
            label: String(option?.label ?? "").trim(),
            description: String(option?.description ?? "").trim(),
            ...(option?.isOther ? { isOther: true } : {}),
          }))
          .filter((option: PendingUserInputQuestionOption) => option.label.length > 0)
        : [];
      return {
        id: String(question?.id ?? `question_${index + 1}`),
        header: typeof question?.header === "string" ? question.header.trim() : undefined,
        question: String(question?.question ?? question?.prompt ?? "").trim() || `Question ${index + 1}`,
        ...(question?.isOther ? { isOther: true } : {}),
        ...(question?.isSecret ? { isSecret: true } : {}),
        ...(options.length > 0 ? { options } : {}),
      } satisfies PendingUserInputQuestion;
    })
    .filter((question: PendingUserInputQuestion) => question.question.length > 0);
}

function buildUserInputKeyboard(question: PendingUserInputQuestion): Record<string, unknown> | null {
  const options = question.options ?? [];
  if (options.length === 0) {
    return null;
  }
  const rows: Array<Array<{ text: string }>> = [];
  for (let index = 0; index < options.length; index += 2) {
    rows.push(options.slice(index, index + 2).map(option => ({ text: option.label })));
  }
  return {
    keyboard: rows,
    one_time_keyboard: true,
    resize_keyboard: true,
    input_field_placeholder: question.isSecret ? "Type your answer" : "Tap or type an answer",
  };
}

function formatUserInputPrompt(questions: PendingUserInputQuestion[]): string {
  const lines = ["Codex requests user input."];
  if (questions.length === 1) {
    const question = questions[0]!;
    if (question.header) {
      lines.push(question.header);
    }
    lines.push(question.question);
    if (question.options?.length) {
      lines.push("");
      lines.push("Choose one of:");
      for (const option of question.options) {
        lines.push(`- ${option.label}${option.description ? `: ${option.description}` : ""}`);
      }
    }
    if (question.isOther) {
      lines.push("");
      lines.push("You can also type a custom answer.");
    }
    lines.push("");
    lines.push("Reply to this message with your answer.");
    return lines.join("\n");
  }

  lines.push("");
  lines.push("Reply with one answer per line using the question number or id, for example:");
  lines.push("1: first answer");
  lines.push("2: second answer");
  lines.push("");
  questions.forEach((question, index) => {
    lines.push(`${index + 1}. ${question.header ? `${question.header}\n` : ""}${question.question}`.trim());
    if (question.options?.length) {
      for (const option of question.options) {
        lines.push(`   - ${option.label}${option.description ? `: ${option.description}` : ""}`);
      }
    }
  });
  return lines.join("\n");
}

function parseUserInputReply(request: PendingUserInputRequest, text: string): Record<string, { answers: string[] }> | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  const questions = request.questions;
  if (questions.length === 1) {
    const answer = trimmed;
    return {
      [questions[0]!.id]: { answers: [answer] },
    };
  }

  const byKey = new Map<string, string[]>();
  const lines = trimmed.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*[:.\-]\s*(.+)$/);
    if (!match) {
      continue;
    }
    const key = match[1]!;
    const value = match[2]!.trim();
    if (!value) {
      continue;
    }
    byKey.set(key, [value]);
  }

  const answers: Record<string, { answers: string[] }> = {};
  let matched = 0;
  for (const [index, question] of questions.entries()) {
    const numericKey = String(index + 1);
    const directKey = question.id;
    const answer = byKey.get(directKey) ?? byKey.get(numericKey);
    if (!answer) {
      continue;
    }
    answers[question.id] = { answers: answer };
    matched += 1;
  }

  if (matched === questions.length) {
    return answers;
  }

  if (lines.length === questions.length) {
    const orderedAnswers: Record<string, { answers: string[] }> = {};
    for (const [index, question] of questions.entries()) {
      const value = lines[index]?.trim();
      if (!value) {
        return null;
      }
      orderedAnswers[question.id] = { answers: [value] };
    }
    return orderedAnswers;
  }

  return null;
}

async function handleServerRequest(
  request: { id: string | number; method: string; params?: any },
  backend: BridgeBackendManager = codex,
  lane: BridgeLane = "primary",
): Promise<void> {
  if (isDynamicToolCallRequest(request.method)) {
    await handleDynamicToolCall(request as { id: string | number; params?: DynamicToolCallRequestParams }, backend);
    return;
  }
  const params = request.params ?? {};
  if (!activeTask || (activeTask.task.lane ?? "primary") !== lane) {
    await backend.rejectServerRequest(request.id, "No active Telegram task context for this approval request.");
    return;
  }
  if (!backend.canRelayApprovals()) {
    await backend.rejectServerRequest(
      request.id,
      "This bridge mode does not support Telegram approval relay. Approve the action in the Codex desktop app.",
    );
    await telegram.sendMessage(activeTask.task.chatId, "This mode requires approvals in the Codex desktop app.");
    return;
  }
  if (![
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
  ].includes(request.method)) {
    if (request.method === "item/tool/requestUserInput") {
      await handleUserInputRequest(request, backend, lane);
      return;
    }
    await backend.rejectServerRequest(request.id, `Unsupported server request: ${request.method}`);
    return;
  }
  const localId = randomUUID().slice(0, 12);
  pendingApprovalRequests.set(localId, {
    requestId: request.id,
    lane,
    method: request.method,
    params,
  });
  const approvalMessage = summarizeApproval(request.method, params);
  const prompt = await telegram.sendMessage(
    activeTask.task.chatId,
    approvalMessage,
    { replyMarkup: telegram.approvalKeyboard(localId, request.method) },
  );
  state.insertApproval({
    localId,
    requestId: String(request.id),
    method: request.method,
    payloadJson: JSON.stringify(params),
    promptMessageId: prompt.message_id,
    createdAt: Date.now(),
    status: "pending",
  });
}

async function handleUserInputRequest(
  request: { id: string | number; method: string; params?: any },
  backend: BridgeBackendManager = codex,
  lane: BridgeLane = "primary",
): Promise<void> {
  const params = request.params ?? {};
  const questions = normalizeUserInputQuestions(params);
  if (questions.length === 0) {
    await backend.rejectServerRequest(request.id, "User input request had no questions.");
    return;
  }
  const localId = randomUUID().slice(0, 12);
  const replyMarkup = questions.length === 1 && questions[0]?.options?.length
    ? buildUserInputKeyboard(questions[0]!)
    : null;
  const promptMessage = await telegram.sendMessage(
    activeTask!.task.chatId,
    formatUserInputPrompt(questions),
    replyMarkup ? { replyMarkup } : undefined,
  );
  pendingUserInputRequests.set(localId, {
    requestId: request.id,
    lane,
    method: request.method,
    params,
    chatId: activeTask!.task.chatId,
    promptMessageId: promptMessage.message_id,
    questions,
  });
  state.recordPendingUserInputDiagnostic({
    localId,
    requestId: String(request.id),
    chatId: activeTask!.task.chatId,
    promptMessageId: promptMessage.message_id,
    questionsJson: JSON.stringify(questions),
    createdAt: Date.now(),
  });
}

async function resolveApproval(callbackQuery: TelegramCallbackQuery): Promise<void> {
  const parsed = TelegramClient.parseApprovalCallback(callbackQuery);
  if (!parsed) {
    return;
  }
  const request = pendingApprovalRequests.get(parsed.localId);
  if (!request) {
    await telegram.answerCallbackQuery(callbackQuery.id, "Approval request no longer exists.");
    return;
  }
  const backend = codexForLane(request.lane ?? "primary");
  try {
    switch (request.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "item/tool/requestUserInput":
        if (parsed.action === "accept") {
          await backend.respondToServerRequest(request.requestId, { decision: "accept" });
        } else if (parsed.action === "acceptSession") {
          await backend.respondToServerRequest(request.requestId, { decision: "acceptForSession" });
        } else if (parsed.action === "deny") {
          await backend.respondToServerRequest(request.requestId, { decision: "decline" });
        } else {
          await backend.respondToServerRequest(request.requestId, { decision: "cancel" });
        }
        break;
      case "item/permissions/requestApproval":
        if (parsed.action === "turn" || parsed.action === "session") {
          await backend.respondToServerRequest(request.requestId, {
            permissions: request.params.permissions ?? {},
            scope: parsed.action,
          });
        } else if (parsed.action === "cancel") {
          await backend.rejectServerRequest(request.requestId, "Permission request cancelled from Telegram.");
          await backend.interruptActiveTurn();
        } else {
          await backend.rejectServerRequest(request.requestId, "Permission request denied from Telegram.");
        }
        break;
      default:
        await backend.rejectServerRequest(request.requestId, `Unsupported approval request: ${request.method}`);
        break;
    }
  } catch (error) {
    state.resolveApproval(parsed.localId, "expired");
    pendingApprovalRequests.delete(parsed.localId);
    wakeWorker();
    logger.warn("approval resolution failed; expiring Telegram approval request", {
      localId: parsed.localId,
      requestId: String(request.requestId),
      error: error instanceof Error ? error.message : String(error),
    });
    await backend.interruptActiveTurn().catch(() => undefined);
    await telegram.answerCallbackQuery(callbackQuery.id, "Approval failed and was expired.");
    return;
  }
  state.resolveApproval(parsed.localId, "resolved");
  pendingApprovalRequests.delete(parsed.localId);
  wakeWorker();
  await telegram.answerCallbackQuery(callbackQuery.id, "Resolved.");
}

function findPendingUserInputRequest(message: TelegramMessage): { localId: string; request: PendingUserInputRequest } | null {
  const chatId = String(message.chat.id);
  const candidates = [...pendingUserInputRequests.entries()]
    .filter(([, request]) => request.chatId === chatId)
    .map(([localId, request]) => ({ localId, request }));
  if (candidates.length === 0) {
    return null;
  }
  const replyToMessageId = message.reply_to_message?.message_id;
  if (typeof replyToMessageId === "number") {
    const replied = candidates.find(entry => entry.request.promptMessageId === replyToMessageId);
    if (replied) {
      return replied;
    }
  }
  return candidates.sort((left, right) => right.request.promptMessageId - left.request.promptMessageId)[0] ?? null;
}

async function resolvePendingUserInput(message: TelegramMessage, text: string): Promise<boolean> {
  const pending = findPendingUserInputRequest(message);
  if (!pending) {
    return false;
  }
  const answers = parseUserInputReply(pending.request, text);
  if (!answers) {
    await telegram.sendMessage(String(message.chat.id), [
      "I found a pending Codex user-input request, but I could not parse that reply.",
      "Reply with one answer per line using the question number or id.",
    ].join("\n"), {
      replyToMessageId: pending.request.promptMessageId,
    });
    return true;
  }
  try {
    await codexForLane(pending.request.lane ?? "primary").respondToServerRequest(pending.request.requestId, { answers });
    pendingUserInputRequests.delete(pending.localId);
    state.resolvePendingUserInputDiagnostic(pending.localId);
    await telegram.sendMessage(String(message.chat.id), "User input sent back to Codex.", {
      replyToMessageId: message.message_id,
      replyMarkup: { remove_keyboard: true },
    });
  } catch (error) {
    logger.warn("failed to resolve Telegram user input request", {
      localId: pending.localId,
      requestId: String(pending.request.requestId),
      error: error instanceof Error ? error.message : String(error),
    });
    state.failPendingUserInputDiagnostic(pending.localId, error);
    await telegram.sendMessage(String(message.chat.id), "Failed to send the reply back to Codex. Please try again.", {
      replyToMessageId: pending.request.promptMessageId,
    });
  }
  return true;
}

function nextSpeakFlag(): boolean {
  const value = state.getSetting<boolean>("telegram:speak_next", false);
  if (value) {
    state.setSetting("telegram:speak_next", false);
  }
  return value;
}

function nextFastAsrFlag(): boolean {
  return consumeFastAsrPreference(state);
}

function armFastAsrPreferenceWindow(task: Pick<QueuedTelegramTask, "id" | "kind">, source: string): void {
  armFastAsrPreference(state);
  logger.info("armed conversational fast ASR preference", {
    taskId: task.id,
    taskKind: task.kind,
    source,
  });
}

function maybeCarryForwardConversationalPreferences(task: QueuedTelegramTask): void {
  if (task.kind === "text") {
    if (task.preferFastAsr) {
      armFastAsrPreferenceWindow(task, "text_request");
    }
    return;
  }
  if (task.kind !== "voice" && task.kind !== "audio" && task.kind !== "video") {
    return;
  }
  if (task.preferFastAsr) {
    armFastAsrPreferenceWindow(task, "media_request");
    return;
  }
  if (shouldCarryForwardFastAsrPreference(task.text, { relaxed: true })) {
    armFastAsrPreferenceWindow(task, "media_caption");
    return;
  }
  if (shouldCarryForwardFastAsrPreference(task.transcriptText, { relaxed: true })) {
    armFastAsrPreferenceWindow(task, "media_transcript");
  }
}

function usesCodexNativeImageGeneration(): boolean {
  return telegramImageGenerationMode(state) === "codex-native";
}

function injectCodexNativeImageGenerationContext(inputs: CodexTurnInput[], task: QueuedTelegramTask): CodexTurnInput[] {
  if (!usesCodexNativeImageGeneration() || classifyTelegramTurnWorkload(task) !== "image_generation") {
    return inputs;
  }
  const firstTextIndex = inputs.findIndex(input => input.type === "text");
  if (firstTextIndex < 0) {
    return inputs;
  }
  const firstText = inputs[firstTextIndex];
  if (!firstText || firstText.type !== "text") {
    return inputs;
  }
  const text = [
    "Bridge note (not from the user):",
    "- Use native Codex image generation when available for this Telegram image request instead of bridge media-provider image APIs.",
    "- Keep the user-facing reply concise. Do not reveal internal paths, storage locations, or bridge implementation details.",
    "",
    firstText.text,
  ].join("\n");
  return inputs.map((input, index) => index === firstTextIndex ? { type: "text", text } : input);
}

async function buildTurnInputs(task: QueuedTelegramTask, placeholderMessageId: number | null): Promise<CodexTurnInput[]> {
  const inputs = await buildTelegramTurnInputs(task, placeholderMessageId, {
    telegram,
    registry,
    artifacts,
    inboundRoot,
    normalizedRoot,
    transcodeToWavImpl: transcodeToWav,
    onTaskUpdated: nextTask => {
      state.replaceTask(nextTask);
    },
  });
  return injectCodexNativeImageGenerationContext(inputs, task);
}

async function maybeSendAudioReply(task: QueuedTelegramTask, finalText: string): Promise<void> {
  if (!task.forceSpeak) {
    return;
  }
  const speech = await registry.speak({ text: finalText });
  const speechArtifact = await artifacts.writeArtifact({
    modality: "audio",
    providerId: speech.providerId,
    source: "automatic",
    buffer: speech.buffer,
    fileExtension: speech.fileExtension,
    mimeType: speech.mimeType,
    metadata: { taskId: task.id },
  });
  await deliverAudioArtifacts({
    telegram,
    chatId: task.chatId,
    artifacts: [speechArtifact],
    outputRoot: outboundRoot,
    markDelivered: artifactId => state.markArtifactDelivered(artifactId),
    markFailed: (artifactId, error) => state.recordArtifactDeliveryFailure(artifactId, error),
    captionForArtifact: () => "AI-generated audio reply.",
    onVoiceFallback: (artifact, error) => {
      logger.warn("sendVoice failed for automatic audio reply, falling back to sendDocument", {
        artifactId: artifact.id,
        error: error instanceof Error ? error.message : String(error),
      });
    },
    onDeliveryFailure: (artifact, error) => {
      logger.warn("failed to deliver automatic audio reply", {
        artifactId: artifact.id,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
}

function mergeUndeliveredArtifacts<T extends { id: string; createdAt: number }>(...groups: T[][]): T[] {
  const unique = new Map<string, T>();
  for (const group of groups) {
    for (const artifact of group) {
      if (!unique.has(artifact.id)) {
        unique.set(artifact.id, artifact);
      }
    }
  }
  return [...unique.values()].sort((left, right) => left.createdAt - right.createdAt);
}

async function maybeSendGeneratedAudio(chatId: string, options?: {
  createdAfter?: number;
  labelOlderAsRecovered?: boolean;
}): Promise<void> {
  const createdAfter = options?.createdAfter ?? 0;
  const recent = createdAfter > 0 ? state.listRecentUndeliveredArtifacts("audio", createdAfter) : [];
  const backlog = state.listRecentUndeliveredArtifacts("audio", 0)
    .filter(artifact => createdAfter === 0 || artifact.createdAt < createdAfter);
  const audioArtifacts = mergeUndeliveredArtifacts(recent, backlog);
  if (audioArtifacts.length === 0) {
    return;
  }
  await deliverAudioArtifacts({
    telegram,
    chatId,
    artifacts: audioArtifacts,
    outputRoot: outboundRoot,
    markDelivered: artifactId => state.markArtifactDelivered(artifactId),
    markFailed: (artifactId, error) => state.recordArtifactDeliveryFailure(artifactId, error),
    captionForArtifact: artifact => {
      if (options?.labelOlderAsRecovered && (createdAfter === 0 || artifact.createdAt < createdAfter)) {
        return "Recovered generated audio from an earlier request.";
      }
      return artifact.source === "mcp" ? "Generated audio." : "AI-generated audio reply.";
    },
    onVoiceFallback: (artifact, error) => {
      logger.warn("sendVoice failed, falling back to sendDocument for generated audio", {
        artifactId: artifact.id,
        error: error instanceof Error ? error.message : String(error),
        path: artifact.path,
      });
    },
    onDeliveryFailure: (artifact, error) => {
      logger.warn("failed to deliver generated audio", {
        artifactId: artifact.id,
        error: error instanceof Error ? error.message : String(error),
        path: artifact.path,
      });
    },
  });
}

async function maybeSendGeneratedImages(chatId: string, options?: {
  createdAfter?: number;
  labelOlderAsRecovered?: boolean;
}): Promise<void> {
  const createdAfter = options?.createdAfter ?? 0;
  const recent = createdAfter > 0 ? artifacts.listRecentUndeliveredImages(createdAfter) : [];
  const backlog = artifacts.listUndeliveredImages()
    .filter(image => createdAfter === 0 || image.createdAt < createdAfter);
  const images = mergeUndeliveredArtifacts(recent, backlog);
  if (images.length === 0) {
    return;
  }
  await deliverImageArtifacts({
    telegram,
    chatId,
    artifacts: images,
    markDelivered: artifactId => state.markArtifactDelivered(artifactId),
    markFailed: (artifactId, error) => state.recordArtifactDeliveryFailure(artifactId, error),
    captionForArtifact: artifact => {
      if (options?.labelOlderAsRecovered && (createdAfter === 0 || artifact.createdAt < createdAfter)) {
        return "Recovered generated image from an earlier request.";
      }
      return "Generated image.";
    },
    onPhotoFallback: (artifact, error) => {
      logger.warn("sendPhoto failed, falling back to sendDocument", {
        artifactId: artifact.id,
        error: error instanceof Error ? error.message : String(error),
        path: artifact.path,
      });
    },
    onDeliveryFailure: (artifact, error) => {
      logger.warn("failed to deliver generated image", {
        artifactId: artifact.id,
        error: error instanceof Error ? error.message : String(error),
        path: artifact.path,
      });
    },
  });
}

function generatedDocumentAllowedRoots(): string[] {
  const roots = new Set<string>();
  const executionCwd = codex.getExecutionCwd();
  const fallbackExecutionCwd = fallbackCodex.getExecutionCwd();
  const boundCwd = codex.getBoundThread()?.cwd ?? state.getBoundThread()?.cwd ?? null;
  for (const candidate of [
    executionCwd,
    fallbackExecutionCwd,
    boundCwd,
    config.codex.workdir,
    config.bridge.fallback_lane?.workdir,
  ]) {
    if (candidate) {
      addGeneratedOutputRootVariants(roots, candidate);
    }
  }
  return [...roots];
}

function generatedDocumentBlockedRoots(): string[] {
  return [resolve(config.storageRoot)];
}

function generatedVideoAllowedRoots(): string[] {
  return generatedDocumentAllowedRoots();
}

function generatedVideoBlockedRoots(): string[] {
  return generatedDocumentBlockedRoots();
}

function generatedAudioAllowedRoots(): string[] {
  return generatedDocumentAllowedRoots();
}

function generatedAudioBlockedRoots(): string[] {
  return generatedDocumentBlockedRoots();
}

function addGeneratedOutputRootVariants(roots: Set<string>, basePath: string): void {
  const base = resolve(basePath);
  roots.add(base);
  for (const relativeOutputRoot of [
    "output",
    "output/audio",
    "output/docs",
    "output/documents",
    "output/imagegen",
    "output/images",
    "output/pdf",
    "output/video",
    "output/videos",
  ]) {
    roots.add(resolve(base, relativeOutputRoot));
  }
}

function generatedInlineImageAllowedRoots(): string[] {
  const roots = new Set<string>();
  const executionCwd = codex.getExecutionCwd();
  const fallbackExecutionCwd = fallbackCodex.getExecutionCwd();
  const boundCwd = codex.getBoundThread()?.cwd ?? state.getBoundThread()?.cwd ?? null;
  for (const candidate of [
    executionCwd,
    fallbackExecutionCwd,
    boundCwd,
    config.codex.workdir,
    config.bridge.fallback_lane?.workdir,
    join(config.storageRoot, "manual-send"),
    join(config.storageRoot, "outbound"),
    "/tmp",
  ]) {
    if (candidate) {
      addGeneratedOutputRootVariants(roots, candidate);
    }
  }
  return [...roots];
}

function generatedInlineImageDiscoveryRoots(): string[] {
  const roots = new Set<string>();
  roots.add(resolve(join(config.storageRoot, "manual-send")));
  roots.add(resolve(join(config.storageRoot, "outbound")));
  const executionCwd = codex.getExecutionCwd();
  const fallbackExecutionCwd = fallbackCodex.getExecutionCwd();
  const boundCwd = codex.getBoundThread()?.cwd ?? state.getBoundThread()?.cwd ?? null;
  for (const candidate of [
    executionCwd,
    fallbackExecutionCwd,
    boundCwd,
    config.codex.workdir,
    config.bridge.fallback_lane?.workdir,
  ]) {
    if (!candidate) {
      continue;
    }
    const base = resolve(candidate);
    roots.add(resolve(base, "output"));
    roots.add(resolve(base, "output/imagegen"));
    roots.add(resolve(base, "output/images"));
  }
  return [...roots];
}

async function stageInlineMarkdownImages(references: { altText: string; rawPath: string }[]): Promise<StoredArtifact[]> {
  const allowedRoots = generatedInlineImageAllowedRoots();
  if (allowedRoots.length === 0 || references.length === 0) {
    return [];
  }

  const artifactsRoot = resolve(join(config.storageRoot, "artifacts"));
  const stagedArtifacts: StoredArtifact[] = [];
  const seenPaths = new Set<string>();

  for (const reference of references) {
    let resolvedPath: string;
    try {
      resolvedPath = await resolveAllowedImagePath(reference.rawPath, allowedRoots);
    } catch (error) {
      logger.warn("failed to resolve inline Markdown image reference", {
        path: reference.rawPath,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (resolvedPath === artifactsRoot || resolvedPath.startsWith(`${artifactsRoot}/`)) {
      logger.warn("refusing to re-stage inline Markdown image from artifact storage", {
        path: resolvedPath,
      });
      continue;
    }
    if (seenPaths.has(resolvedPath)) {
      continue;
    }
    seenPaths.add(resolvedPath);

    try {
      const artifact = await artifacts.stageExistingFile({
        modality: "image",
        providerId: "bridge",
        source: "automatic",
        sourcePath: resolvedPath,
        mimeType: mimeTypeForInspectablePath(resolvedPath),
        metadata: {
          kind: "generated-inline-image",
          altText: reference.altText,
          originalPath: resolvedPath,
        },
      });
      stagedArtifacts.push(artifact);
    } catch (error) {
      logger.warn("failed to stage inline Markdown image for Telegram delivery", {
        path: resolvedPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return stagedArtifacts;
}

async function stageReferencedGeneratedImages(finalText: string, turnStartedAt: number): Promise<StoredArtifact[]> {
  const allowedRoots = generatedInlineImageAllowedRoots();
  if (allowedRoots.length === 0) {
    return [];
  }
  const artifactsRoot = resolve(join(config.storageRoot, "artifacts"));
  const referencedPaths = await collectReferencedGeneratedImages(finalText, {
    allowedRoots,
    blockedRoots: [artifactsRoot],
    minModifiedAtMs: Math.max(0, turnStartedAt - 2_000),
  });
  if (referencedPaths.length === 0) {
    return [];
  }

  const stagedArtifacts: StoredArtifact[] = [];
  for (const sourcePath of referencedPaths) {
    try {
      const artifact = await artifacts.stageExistingFile({
        modality: "image",
        providerId: "bridge",
        source: "automatic",
        sourcePath,
        mimeType: mimeTypeForInspectablePath(sourcePath),
        metadata: {
          kind: "generated-inline-image",
          originalPath: sourcePath,
        },
      });
      stagedArtifacts.push(artifact);
    } catch (error) {
      logger.warn("failed to stage referenced generated image for Telegram delivery", {
        path: sourcePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return stagedArtifacts;
}

async function stageRecentGeneratedImagesForVisualTask(
  task: QueuedTelegramTask,
  turnStartedAt: number,
  alreadyStagedOriginalPaths: Set<string>,
): Promise<StoredArtifact[]> {
  const workload = classifyTelegramTurnWorkload(task);
  if (workload !== "visual_delivery" && workload !== "image_generation") {
    return [];
  }
  const artifactsRoot = resolve(join(config.storageRoot, "artifacts"));
  const recentPaths = await collectRecentGeneratedImages({
    allowedRoots: generatedInlineImageDiscoveryRoots(),
    blockedRoots: [artifactsRoot],
    minModifiedAtMs: Math.max(0, turnStartedAt - 2_000),
    maxCount: 5,
    maxDepth: 2,
  });
  if (recentPaths.length === 0) {
    return [];
  }

  const stagedArtifacts: StoredArtifact[] = [];
  for (const sourcePath of recentPaths) {
    if (alreadyStagedOriginalPaths.has(sourcePath)) {
      continue;
    }
    try {
      const artifact = await artifacts.stageExistingFile({
        modality: "image",
        providerId: "bridge",
        source: "automatic",
        sourcePath,
        mimeType: mimeTypeForInspectablePath(sourcePath),
        metadata: {
          kind: "recent-visual-delivery-image",
          taskId: task.id,
          altText: "Requested image.",
          originalPath: sourcePath,
        },
      });
      stagedArtifacts.push(artifact);
    } catch (error) {
      logger.warn("failed to stage recent generated image for Telegram delivery", {
        taskId: task.id,
        path: sourcePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return stagedArtifacts;
}

async function stageReferencedGeneratedDocuments(taskId: string, finalText: string, turnStartedAt: number): Promise<void> {
  const allowedRoots = generatedDocumentAllowedRoots();
  if (allowedRoots.length === 0) {
    return;
  }
  const referencedPaths = await collectReferencedGeneratedDocuments(finalText, {
    allowedRoots,
    blockedRoots: generatedDocumentBlockedRoots(),
    minModifiedAtMs: Math.max(0, turnStartedAt - 2_000),
  });
  if (referencedPaths.length === 0) {
    return;
  }
  for (const sourcePath of referencedPaths) {
    try {
      await artifacts.stageExistingFile({
        modality: "document",
        providerId: "bridge",
        source: "automatic",
        sourcePath,
        mimeType: mimeTypeForGeneratedDocument(sourcePath),
        metadata: {
          taskId,
          kind: "generated-document",
        },
      });
    } catch (error) {
      logger.warn("failed to stage generated document for Telegram delivery", {
        taskId,
        path: sourcePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function stageReferencedGeneratedVideos(taskId: string, finalText: string, turnStartedAt: number): Promise<void> {
  const allowedRoots = generatedVideoAllowedRoots();
  if (allowedRoots.length === 0) {
    return;
  }
  const referencedPaths = await collectReferencedGeneratedVideos(finalText, {
    allowedRoots,
    blockedRoots: generatedVideoBlockedRoots(),
    minModifiedAtMs: Math.max(0, turnStartedAt - 2_000),
  });
  if (referencedPaths.length === 0) {
    return;
  }
  for (const sourcePath of referencedPaths) {
    try {
      await artifacts.stageExistingFile({
        modality: "video",
        providerId: "bridge",
        source: "automatic",
        sourcePath,
        mimeType: mimeTypeForGeneratedVideo(sourcePath),
        metadata: {
          taskId,
          kind: "generated-video",
        },
      });
    } catch (error) {
      logger.warn("failed to stage generated video for Telegram delivery", {
        taskId,
        path: sourcePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function stageReferencedGeneratedAudio(taskId: string, finalText: string, turnStartedAt: number): Promise<void> {
  const allowedRoots = generatedAudioAllowedRoots();
  if (allowedRoots.length === 0) {
    return;
  }
  const referencedPaths = await collectReferencedGeneratedAudio(finalText, {
    allowedRoots,
    blockedRoots: generatedAudioBlockedRoots(),
    minModifiedAtMs: Math.max(0, turnStartedAt - 2_000),
  });
  if (referencedPaths.length === 0) {
    return;
  }
  for (const sourcePath of referencedPaths) {
    try {
      await artifacts.stageExistingFile({
        modality: "audio",
        providerId: "bridge",
        source: "automatic",
        sourcePath,
        mimeType: mimeTypeForGeneratedAudio(sourcePath),
        metadata: {
          taskId,
          kind: "generated-audio",
        },
      });
    } catch (error) {
      logger.warn("failed to stage generated audio for Telegram delivery", {
        taskId,
        path: sourcePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function maybeSendGeneratedDocuments(chatId: string, options?: {
  createdAfter?: number;
  labelOlderAsRecovered?: boolean;
}): Promise<void> {
  const createdAfter = options?.createdAfter ?? 0;
  const recent = createdAfter > 0 ? state.listRecentUndeliveredArtifacts("document", createdAfter) : [];
  const backlog = state.listRecentUndeliveredArtifacts("document", 0)
    .filter(artifact => createdAfter === 0 || artifact.createdAt < createdAfter);
  const documentArtifacts = mergeUndeliveredArtifacts(recent, backlog);
  if (documentArtifacts.length === 0) {
    return;
  }
  await deliverDocumentArtifacts({
    telegram,
    chatId,
    artifacts: documentArtifacts,
    markDelivered: artifactId => state.markArtifactDelivered(artifactId),
    markFailed: (artifactId, error) => state.recordArtifactDeliveryFailure(artifactId, error),
    captionForArtifact: artifact => {
      if (options?.labelOlderAsRecovered && (createdAfter === 0 || artifact.createdAt < createdAfter)) {
        return "Recovered generated document from an earlier request.";
      }
      return "Generated file.";
    },
    onDeliveryFailure: (artifact, error) => {
      logger.warn("failed to deliver generated document", {
        artifactId: artifact.id,
        error: error instanceof Error ? error.message : String(error),
        path: artifact.path,
      });
    },
  });
}

async function maybeSendGeneratedVideos(chatId: string, options?: {
  createdAfter?: number;
  labelOlderAsRecovered?: boolean;
}): Promise<void> {
  const createdAfter = options?.createdAfter ?? 0;
  const recent = createdAfter > 0 ? state.listRecentUndeliveredArtifacts("video", createdAfter) : [];
  const backlog = state.listRecentUndeliveredArtifacts("video", 0)
    .filter(artifact => createdAfter === 0 || artifact.createdAt < createdAfter);
  const videoArtifacts = mergeUndeliveredArtifacts(recent, backlog);
  if (videoArtifacts.length === 0) {
    return;
  }
  await deliverVideoArtifacts({
    telegram,
    chatId,
    artifacts: videoArtifacts,
    markDelivered: artifactId => state.markArtifactDelivered(artifactId),
    markFailed: (artifactId, error) => state.recordArtifactDeliveryFailure(artifactId, error),
    captionForArtifact: artifact => {
      if (options?.labelOlderAsRecovered && (createdAfter === 0 || artifact.createdAt < createdAfter)) {
        return "Recovered generated video from an earlier request.";
      }
      return "Generated video.";
    },
    onVideoFallback: (artifact, error) => {
      logger.warn("failed to send generated video, falling back to document", {
        artifactId: artifact.id,
        error: error instanceof Error ? error.message : String(error),
        path: artifact.path,
      });
    },
    onDeliveryFailure: (artifact, error) => {
      logger.warn("failed to deliver generated video", {
        artifactId: artifact.id,
        error: error instanceof Error ? error.message : String(error),
        path: artifact.path,
      });
    },
  });
}

function renderCallArtifactPrompt(artifact: CallArtifact): string {
  return [
    "A live voice call just ended. Treat the following as a structured handoff artifact for this bound Codex session.",
    "Absorb it into your working context and continue from it in later turns.",
    "Reply briefly with a one-paragraph acknowledgement and the most important next step.",
    "",
    JSON.stringify(artifact, null, 2),
  ].join("\n");
}

async function appendCallArtifactToCodex(call: ActiveCallRecord, artifact: CallArtifact): Promise<string> {
  await codex.sync();
  const result = await codex.startTurn([{
    type: "text",
    text: renderCallArtifactPrompt(artifact),
  }]);
  return result.finalText || artifact.summary;
}

async function canAttemptCallHandoffAppend(expectedBoundThreadId: string | null): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (activeTask || state.getActiveTask()) {
    return { ok: false, reason: "a Telegram request is already in flight on the shared session" };
  }
  if (codex.hasActiveTurn()) {
    return { ok: false, reason: "the shared Codex session is already executing another turn" };
  }
  if (await currentSharedThreadExternalTurnId()) {
    return { ok: false, reason: "the bound desktop Codex session is already executing another turn" };
  }
  if (state.getPendingApprovalCount() > 0) {
    return { ok: false, reason: "a pending approval must be resolved first" };
  }
  if (codex.getMode() !== "autonomous-thread" && !state.getBoundThread()) {
    return { ok: false, reason: "no bound desktop Codex thread is attached" };
  }
  if (codex.getMode() !== "autonomous-thread" && expectedBoundThreadId) {
    const currentBoundThreadId = state.getBoundThread()?.threadId ?? null;
    if (currentBoundThreadId !== expectedBoundThreadId) {
      return { ok: false, reason: "the shared session is now bound to a different desktop thread" };
    }
  }
  if (codex.getOwner() !== "telegram") {
    return { ok: false, reason: "Telegram does not currently own the session" };
  }
  return { ok: true };
}

async function attemptCallArtifactAppend(call: ActiveCallRecord, artifact: CallArtifact): Promise<
  | { status: "appended"; acknowledgement: string }
  | { status: "deferred"; reason: string }
> {
  const readiness = await canAttemptCallHandoffAppend(call.boundThreadId);
  if (!readiness.ok) {
    return {
      status: "deferred",
      reason: readiness.reason,
    };
  }

  const prompt = renderCallArtifactPrompt(artifact);
  const promptHash = createHash("sha256").update(prompt).digest("hex");
  const claim = state.beginCallHandoffAppend(call.callId, promptHash);
  if (claim.status === "already_appended") {
    return {
      status: "appended",
      acknowledgement: claim.acknowledgement ?? artifact.summary,
    };
  }
  if (claim.status === "already_in_progress") {
    return {
      status: "deferred",
      reason: "the call handoff append is already in progress",
    };
  }

  try {
    const appendPromise = appendCallArtifactToCodex(call, artifact)
      .then(acknowledgement => {
        state.completeCallHandoffAppend(call.callId, acknowledgement);
        return acknowledgement;
      })
      .catch(error => {
        state.failCallHandoffAppend(call.callId, error);
        throw error;
      });
    const acknowledgement = await Promise.race([
      appendPromise,
      sleep(CALL_HANDOFF_APPEND_TIMEOUT_MS).then(() => null),
    ]);
    if (acknowledgement === null) {
      return {
        status: "deferred",
        reason: "timed out waiting to append the call handoff into Codex",
      };
    }
    return { status: "appended", acknowledgement };
  } catch (error) {
    return {
      status: "deferred",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function requestGatewayHangup(callId: string, reason: string): Promise<void> {
  const delivered = await gatewayClient.requestHangup({ callId, reason }).catch(() => false);
  if (delivered) {
    return;
  }
  if (!env.realtimeControlSecret) {
    return;
  }
  await fetch(`http://${config.realtime.gateway_host}:${config.realtime.gateway_port}/api/call/hangup`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bridge-secret": env.realtimeControlSecret,
    },
    body: JSON.stringify({ callId, reason }),
  }).catch(() => undefined);
}

async function callArtifactAlreadyAppended(call: ActiveCallRecord, artifact: CallArtifact): Promise<boolean> {
  if (call.artifactAppendedAt) {
    return true;
  }
  const binding = state.getBoundThread();
  if (!binding?.rolloutPath || binding.threadId !== call.boundThreadId) {
    return false;
  }
  const rollout = await readFile(binding.rolloutPath, "utf8").catch(() => "");
  return rollout.includes(`"callId": "${artifact.callId}"`);
}

function callArtifactHasUsableContent(artifact: CallArtifact, transcript: string): boolean {
  const transcriptBody = transcript
    .split("\n")
    .map(line => line.trim())
    .filter(line =>
      Boolean(line)
      && !line.startsWith("# Call")
      && !line.startsWith("## User")
      && !line.startsWith("## Assistant"))
    .join("\n");
  return Boolean(
    transcriptBody
    || artifact.attachments.length > 0
    || artifact.decisions.length > 0
    || artifact.actionItems.length > 0
    || artifact.openQuestions.length > 0
    || artifact.importantFacts.length > 0,
  );
}

function buildRecentCallSummary(
  call: ActiveCallRecord,
  reason: string,
  hasUsableContent: boolean,
  handoffQueued: boolean,
): RecentCallSummary {
  return {
    callId: call.callId,
    endedAt: call.endedAt ?? Date.now(),
    endedReason: reason,
    transcriptPath: call.transcriptPath,
    handoffJsonPath: call.handoffJsonPath,
    handoffMarkdownPath: call.handoffMarkdownPath,
    bundlePath: dirname(call.handoffMarkdownPath),
    hasUsableContent,
    handoffQueued,
    artifactAppendedAt: call.artifactAppendedAt,
    recapMessageId: call.recapMessageId,
  };
}

async function finalizeCall(
  call: ActiveCallRecord,
  reason: string,
  options?: { notifyGateway?: boolean; endedAt?: number },
): Promise<CallArtifact | null> {
  if (!callNeedsFinalization(call)) {
    return null;
  }
  if (finalizingCalls.has(call.callId)) {
    return null;
  }
  finalizingCalls.add(call.callId);
  const finalizing: ActiveCallRecord = {
    ...call,
    status: "finalizing",
    updatedAt: Date.now(),
    endedReason: reason,
  };
  try {
    state.setActiveCall(finalizing);
    if (options?.notifyGateway !== false) {
      await requestGatewayHangup(call.callId, reason);
    }
    await waitForPendingCallInboxStages(call.callId);
    let currentCall = finalizing;
    const endedAt = options?.endedAt ?? call.endedAt ?? Date.now();
    const { call: endedCall, artifact } = await callStore.finalize(finalizing, { reason, endedAt });
    currentCall = {
      ...endedCall,
      status: "finalizing",
      updatedAt: Date.now(),
    };
    state.setActiveCall(currentCall);
    state.recordRealtimeCallUsageOnce(
      endedCall.callId,
      Math.max(0, (endedCall.endedAt ?? Date.now()) - endedCall.startedAt),
      endedCall.endedAt ?? Date.now(),
    );
    const transcript = await readFile(currentCall.transcriptPath, "utf8").catch(() => "");
    const hasUsableContent = callArtifactHasUsableContent(artifact, transcript);
    let handoffQueued = false;
    let recap = [
      "Live call ended.",
      `Reason: ${reason}`,
      "",
      artifact.summary,
    ].join("\n");
    if (!hasUsableContent) {
      recap = [
        recap,
        "",
        "No usable transcript or staged call attachments were captured, so nothing was appended back into the Codex thread.",
      ].join("\n");
    } else if (!await callArtifactAlreadyAppended(currentCall, artifact)) {
      const appendResult = await attemptCallArtifactAppend(currentCall, artifact);
      if (appendResult.status === "appended") {
        const acknowledgement = appendResult.acknowledgement;
        currentCall = callStore.markArtifactAppended(currentCall);
        recap = [
          recap,
          "",
          "Codex follow-up:",
          acknowledgement,
        ].join("\n");
      } else {
        const now = Date.now();
        handoffQueued = true;
        state.upsertPendingCallHandoff({
          callId: currentCall.callId,
          artifact,
          chatId: config.telegram.authorized_chat_id,
          createdAt: now,
          updatedAt: now,
          attemptCount: 1,
          lastError: appendResult.reason,
        });
        recap = [
          recap,
          "",
          "Codex handoff is queued and will be appended when the shared session is idle.",
          `Reason: ${appendResult.reason}`,
        ].join("\n");
        wakeWorker();
      }
    } else {
      currentCall = currentCall.artifactAppendedAt ? currentCall : callStore.markArtifactAppended(currentCall);
      recap = [
        recap,
        "",
        "Codex handoff was already appended before the bridge restarted.",
      ].join("\n");
    }
    state.setRecentCallSummary(buildRecentCallSummary(currentCall, reason, hasUsableContent, handoffQueued));
    if (!currentCall.recapMessageId) {
      try {
        const sent = await Promise.race([
          telegram.sendMessage(config.telegram.authorized_chat_id, recap),
          sleep(CALL_RECAP_SEND_TIMEOUT_MS).then(() => {
            throw new Error("timed out waiting to deliver the Telegram call recap");
          }),
        ]);
        currentCall = {
          ...(state.getActiveCall() ?? currentCall),
          recapMessageId: sent.message_id,
        };
        state.setActiveCall(currentCall);
        state.updateRecentCallSummary(currentCall.callId, {
          recapMessageId: sent.message_id,
        });
      } catch (error) {
        logger.warn("failed to send Telegram call recap", {
          callId: call.callId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    logger.info("call finalized", {
      bridgeId: config.realtime.bridge_id,
      callId: currentCall.callId,
      reason,
      hasUsableContent,
      handoffQueued,
      endedAt: formatTimestamp(currentCall.endedAt),
      artifactAppendedAt: formatTimestamp(currentCall.artifactAppendedAt),
      transcriptPath: currentCall.transcriptPath,
      handoffMarkdownPath: currentCall.handoffMarkdownPath,
      recapMessageId: currentCall.recapMessageId,
    });
    callStore.clearActiveCall(call.callId);
    await gatewayClient.sendStatus(gatewayStatusPayload()).catch(() => undefined);
    wakeWorker();
    return artifact;
  } finally {
    finalizingCalls.delete(call.callId);
  }
}

async function stageCallInboxItem(task: QueuedTelegramTask): Promise<CallInboxItem> {
  const call = getActiveCall();
  if (!call) {
    throw new Error("No active call.");
  }
  validateTelegramTaskForProcessing(task);
  const item: CallInboxItem = {
    ...task,
    callId: call.callId,
    status: "queued",
  };
  if (task.kind === "image" && task.photoFileId) {
    const imagePath = imageDownloadPathForTask(task, inboundRoot);
    await withTimeout(
      telegram.downloadFile(task.photoFileId, imagePath, {
        maxBytes: MAX_IMAGE_INPUT_BYTES,
        timeoutMs: TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
      }),
      CALL_INBOX_STEP_TIMEOUT_MS,
      "timed out downloading the in-call image attachment",
    );
    item.stagedImagePath = imagePath;
    item.status = "staged";
  }
  if (task.kind === "document" && task.documentFileId) {
    const documentPath = documentDownloadPathForTask(task, inboundRoot);
    await withTimeout(
      telegram.downloadFile(task.documentFileId, documentPath, {
        maxBytes: MAX_DOCUMENT_INPUT_BYTES,
        timeoutMs: TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
      }),
      CALL_INBOX_STEP_TIMEOUT_MS,
      "timed out downloading the in-call document attachment",
    );
    item.documentPath = documentPath;
    item.status = "staged";
  }
  if (task.kind === "video" && task.videoFileId) {
    const extension = extname(task.videoFileName ?? "")
      || extname(task.videoMimeType ?? "").replace(".", "")
      || "mp4";
    const videoPath = join(inboundRoot, `${task.id}.${extension.startsWith(".") ? extension.slice(1) : extension}`);
    const previewPath = join(inboundRoot, `${task.id}.jpg`);
    const normalizedPath = join(normalizedRoot, `${task.id}.wav`);
    await withTimeout(
      telegram.downloadFile(task.videoFileId, videoPath, {
        maxBytes: MAX_VIDEO_INPUT_BYTES,
        timeoutMs: TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
      }),
      CALL_INBOX_STEP_TIMEOUT_MS,
      "timed out downloading the in-call video attachment",
    );
    item.videoPath = videoPath;
    await withTimeout(
      extractVideoFrame(videoPath, previewPath),
      CALL_INBOX_STEP_TIMEOUT_MS,
      "timed out extracting the in-call video preview frame",
    );
    item.mediaPreviewPath = previewPath;
    await withTimeout(
      transcodeToWav(videoPath, normalizedPath),
      CALL_INBOX_STEP_TIMEOUT_MS,
      "timed out normalizing the in-call video attachment",
    );
    item.normalizedMediaPath = normalizedPath;
    const transcript = await withTimeout(
      registry.transcribe({ filePath: normalizedPath }),
      CALL_INBOX_STEP_TIMEOUT_MS,
      "timed out transcribing the in-call video attachment",
    );
    const transcriptArtifact = await artifacts.writeArtifact({
      modality: "transcript",
      providerId: transcript.providerId,
      source: "telegram",
      buffer: Buffer.from(transcript.text, "utf8"),
      fileExtension: "txt",
      mimeType: "text/plain",
      metadata: {
        taskId: task.id,
        source: "call_inbox",
        kind: task.kind,
      },
    });
    item.transcriptText = transcript.text;
    item.transcriptArtifactId = transcriptArtifact.id;
    item.transcriptPath = transcriptArtifact.path;
    item.status = "staged";
  }
  if ((task.kind === "voice" || task.kind === "audio") && task.mediaFileId) {
    const extension = task.kind === "voice"
      ? "ogg"
      : task.mediaFileName
        ? task.mediaFileName.split(".").pop() || "bin"
        : "bin";
    const originalPath = join(inboundRoot, `${task.id}.${extension}`);
    const normalizedPath = join(normalizedRoot, `${task.id}.wav`);
    await withTimeout(
      telegram.downloadFile(task.mediaFileId, originalPath, {
        maxBytes: MAX_AUDIO_INPUT_BYTES,
        timeoutMs: TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
      }),
      CALL_INBOX_STEP_TIMEOUT_MS,
      "timed out downloading the in-call audio attachment",
    );
    item.mediaPath = originalPath;
    await withTimeout(
      transcodeToWav(originalPath, normalizedPath),
      CALL_INBOX_STEP_TIMEOUT_MS,
      "timed out normalizing the in-call audio attachment",
    );
    const transcript = await withTimeout(
      registry.transcribe({ filePath: normalizedPath }),
      CALL_INBOX_STEP_TIMEOUT_MS,
      "timed out transcribing the in-call audio attachment",
    );
    const transcriptArtifact = await artifacts.writeArtifact({
      modality: "transcript",
      providerId: transcript.providerId,
      source: "telegram",
      buffer: Buffer.from(transcript.text, "utf8"),
      fileExtension: "txt",
      mimeType: "text/plain",
      metadata: {
        taskId: task.id,
        source: "call_inbox",
        kind: task.kind,
      },
    });
    item.transcriptText = transcript.text;
    item.transcriptArtifactId = transcriptArtifact.id;
    item.transcriptPath = transcriptArtifact.path;
    item.status = "staged";
  }
  state.enqueueCallInboxItem(item);
  try {
    await callStore.attachInboxItem(call, item);
  } catch (error) {
    state.deleteCallInboxItem(item.id);
    throw error;
  }
  state.updateCallInboxItem({
    ...item,
    status: "included",
  });
  return {
    ...item,
    status: "included",
  };
}

async function sendCallStatus(chatId: string): Promise<void> {
  const call = getActiveCall();
  const { surface, gatewayReady, gatewayConnected, publicSurface, blocker } = await inspectCallStartState();
  const activeTaskRecord = state.getActiveTask();
  const queuedTasks = state.getQueuedTaskCount();
  const pendingCallHandoffs = state.getPendingCallHandoffCount();
  const recentCall = summarizeRecentCall(state.getRecentCallSummary(), config.repoRoot);
  const recentFailedTask = summarizeRecentFailedTask(state.getMostRecentFailedTaskSince(DAEMON_STARTED_AT));
  const recentCallEvents = summarizeRecentCallSurfaceEvents(surface);
  const realtimeBudget = getRealtimeBudgetSnapshot(config, state);
  const pendingUserInputCount = Math.max(
    pendingUserInputRequests.size,
    state.getPendingUserInputDiagnosticCount(),
  );
  const managedTunnelCooldown = managedTunnelRecoveryCooldownTelegramLine();
  const desktopTurnId = await currentSharedThreadExternalTurnId();
  const publicCallReady = gatewayReady && gatewayConnected && publicSurface.ready;
  const publicCallIssue = summarizePublicCallIssue({
    surface,
    gatewayReady,
    gatewayConnected,
    publicSurfaceReady: publicSurface.ready,
    publicSurfaceDetail: publicSurface.detail,
  });
  let callStartBlocker = summarizeCallStartBlocker({
    activeTask: activeTaskRecord,
    activeCall: call,
    queuedTasks,
    pendingApprovals: state.getPendingApprovalCount(),
    pendingCallHandoffs,
    owner: state.getOwner("none"),
    binding: state.getBoundThread(),
    desktopTurnId,
    explicitLiveCall: true,
  });
  const liveCallPriority = describeLiveCallPriorityHint({
    activeTask: activeTaskRecord,
    queuedTasks,
    pendingCallHandoffs,
  });
  if (managedTunnelCooldown && !call) {
    callStartBlocker = "managed tunnel recovery is cooling down";
  }
  if (!call) {
    const lines = [
      "Live call status",
      "Call: none",
      `Surface: ${effectiveCallSurfaceStatus(surface, publicCallReady)}`,
      `Surface armed: ${surface.armed ? "yes" : "no"}`,
      `Surface expires in: ${formatSurfaceExpiry(surface.expiresAt)}`,
      `Launch token ready: ${launchTokenReadyForCurrentBridge(surface) ? "yes" : "no"}`,
      `Launch token: ${describeLaunchTokenState(surface)}`,
      `Queued Telegram work: ${queuedTasks === 0 ? "none" : `${queuedTasks} waiting`}`,
      `Active task: ${activeTaskRecord ? `${activeTaskRecord.queueId} (${activeTaskRecord.stage}, ${formatAgeSeconds(activeTaskRecord.startedAt)})` : "none"}`,
      `Live call blocker: ${callStartBlocker}`,
      `Recent failed task: ${recentFailedTask.label}`,
      `Realtime budget: ${describeRealtimeBudget(realtimeBudget)}`,
      `Gateway: ${gatewayReady ? "ready" : "down"} / ${gatewayConnected ? "bridge-connected" : "bridge-disconnected"}`,
      `Public call surface: ${publicCallReady ? "ready" : publicCallIssue}`,
      `Last public probe: ${surface.lastPublicProbeDetail ? `${surface.lastPublicProbeDetail} @ ${formatTimestamp(surface.lastPublicProbeAt)}` : "none"}`,
      `Recent call: ${recentCall.label}`,
    ];
    if (liveCallPriority) {
      lines.push(`Live-call priority: ${liveCallPriority}`);
    }
    if (managedTunnelCooldown) {
      lines.push(managedTunnelCooldown);
    }
    if (recentFailedTask.error !== "none") {
      lines.push(`Recent failed task error: ${recentFailedTask.error}`);
    }
    if (recentCall.bundle !== "none") {
      lines.push(`Recent call bundle: ${recentCall.bundle}`);
      lines.push(`Recent call handoff: ${recentCall.appendStatus}`);
    }
    if (recentCallEvents.length > 0) {
      recentCallEvents.forEach((entry, index) => lines.push(`Recent /call activity ${index + 1}: ${entry}`));
    } else {
      lines.push("Recent /call activity: none");
    }
    if (blocker && !shouldSuppressExplicitLiveCallBlocker(blocker)) {
      lines.push(`Call start blocker: ${blocker.summary}`);
      lines.push(`Next step: ${blocker.nextStep}`);
      if (shouldOfferCallEnableRequest(blocker)) {
        lines.push(buildCallEnableOfferLine());
      }
    }
    await telegram.sendMessage(chatId, lines.join("\n"));
    return;
  }
  const lines = [
    "Live call status",
    `Call: ${call.callId}`,
    `Status: ${call.status}`,
    `Surface: ${effectiveCallSurfaceStatus(surface, publicCallReady, call)}`,
    `Started: ${new Date(call.startedAt).toISOString()}`,
    `Bound thread: ${call.boundThreadId ?? "(none)"}`,
    `In-call inbox: ${state.getCallInboxCount(call.callId)}`,
    `Per-call cap: ${formatRealtimeBudgetSeconds(config.realtime.max_call_ms)}`,
    `Remaining today: ${formatRealtimeBudgetSeconds(realtimeBudget.remainingMs)}`,
    `Queued Telegram work: ${queuedTasks === 0 ? "none" : `${queuedTasks} waiting`}`,
    `Active task: ${activeTaskRecord ? `${activeTaskRecord.queueId} (${activeTaskRecord.stage}, ${formatAgeSeconds(activeTaskRecord.startedAt)})` : "none"}`,
    `Live call blocker: ${callStartBlocker}`,
    `Recent failed task: ${recentFailedTask.label}`,
    `Gateway: ${gatewayReady ? "ready" : "down"} / ${gatewayConnected ? "bridge-connected" : "bridge-disconnected"}`,
    `Public call surface: ${publicCallReady ? "ready" : publicCallIssue}`,
    `Last public probe: ${surface.lastPublicProbeDetail ? `${surface.lastPublicProbeDetail} @ ${formatTimestamp(surface.lastPublicProbeAt)}` : "none"}`,
    `Recent call: ${recentCall.label}`,
  ];
  if (liveCallPriority) {
    lines.push(`Live-call priority: ${liveCallPriority}`);
  }
  if (managedTunnelCooldown) {
    lines.push(managedTunnelCooldown);
  }
  if (recentFailedTask.error !== "none") {
    lines.push(`Recent failed task error: ${recentFailedTask.error}`);
  }
  if (recentCall.bundle !== "none") {
    lines.push(`Recent call bundle: ${recentCall.bundle}`);
    lines.push(`Recent call handoff: ${recentCall.appendStatus}`);
  }
  if (recentCallEvents.length > 0) {
    recentCallEvents.forEach((entry, index) => lines.push(`Recent /call activity ${index + 1}: ${entry}`));
  } else {
    lines.push("Recent /call activity: none");
  }
  if (blocker && !shouldSuppressExplicitLiveCallBlocker(blocker)) {
    lines.push(`Call start blocker: ${blocker.summary}`);
    lines.push(`Next step: ${blocker.nextStep}`);
    if (shouldOfferCallEnableRequest(blocker)) {
      lines.push(buildCallEnableOfferLine());
    }
  }
  await telegram.sendMessage(chatId, lines.join("\n"));
}

function taskNeedsImmediatePlaceholder(task: QueuedTelegramTask): boolean {
  return task.kind !== "text" || codex.getMode() !== "autonomous-thread";
}

async function prepareGatewayCall(payload: {
  callId: string;
  telegramUserId: string | null;
  telegramChatInstance: string | null;
}): Promise<{
  call: ActiveCallRecord;
  contextPack: Awaited<ReturnType<typeof buildCallContextPack>>;
  maxCallMs: number;
}> {
  await requireReadyForCallStart({
    explicit: true,
    reason: "live-call Mini App bootstrap",
    bootstrap: true,
  });
  if (payload.telegramUserId && payload.telegramUserId !== config.telegram.authorized_chat_id) {
    throw new Error("Telegram Mini App user is not authorized for this bridge.");
  }
  const usage = state.getRealtimeUsage();
  const remainingBudgetMs = Math.max(0, config.realtime.max_daily_call_ms - usage.totalCallMs);
  const maxCallMs = Math.min(config.realtime.max_call_ms, remainingBudgetMs);
  if (maxCallMs <= 0) {
    throw new Error("Today's realtime call budget is exhausted.");
  }
  const binding = state.getBoundThread();
  const call = await callStore.create({
    callId: payload.callId,
    bridgeId: config.realtime.bridge_id,
    boundThreadId: binding?.threadId ?? null,
    cwd: binding?.cwd ?? null,
    telegramUserId: payload.telegramUserId,
    telegramChatInstance: payload.telegramChatInstance,
    contextPack: null,
  });
  await gatewayClient.sendStatus(gatewayStatusPayload()).catch(() => undefined);
  try {
    const contextPack = await withTimeout(
      buildCallContextPack({
        callId: payload.callId,
        boundThread: binding,
        mode: codex.getMode(),
        owner: codex.getOwner(),
        state,
      }),
      CALL_CONTEXT_BUILD_TIMEOUT_MS,
      "timed out building live call context from the bound session",
    );
    const currentCall = getActiveCall();
    if (!currentCall || currentCall.callId !== call.callId || !isCallLive(currentCall)) {
      throw new Error("The live call was cancelled before bootstrap finished.");
    }
    const callWithContext = await callStore.updateContextPack(currentCall, contextPack);
    await gatewayClient.sendStatus(gatewayStatusPayload()).catch(() => undefined);
    return { call: callWithContext, contextPack, maxCallMs };
  } catch (error) {
    const currentCall = getActiveCall();
    if (currentCall?.callId === call.callId && !callNeedsFinalization(currentCall)) {
      callStore.clearActiveCall(call.callId);
      await gatewayClient.sendStatus(gatewayStatusPayload()).catch(() => undefined);
    }
    throw error;
  }
}

async function handleGatewayCallEvent(payload: { callId: string; event: any }): Promise<void> {
  const call = getActiveCall();
  if (!call || call.callId !== payload.callId) {
    return;
  }
  const updatedCall = await callStore.appendEvent(call, payload.event);
  if (payload.event.type === "call.ended") {
    await finalizeCall(updatedCall, payload.event.reason ?? "call_ended", { notifyGateway: false });
  }
}

async function recoverInterruptedCall(): Promise<void> {
  const call = getActiveCall();
  if (!callNeedsFinalization(call)) {
    return;
  }
  await finalizeCall(call, call.endedReason ?? "interrupted", {
    notifyGateway: false,
    ...(call.endedAt ? { endedAt: call.endedAt } : {}),
  }).catch(error => {
    logger.warn("failed to recover interrupted call", {
      callId: call.callId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

async function flushPendingCallHandoffs(): Promise<void> {
  const pending = state.listPendingCallHandoffs();
  if (pending.length === 0) {
    return;
  }
  if (isCallLive(getActiveCall())) {
    return;
  }
  for (const handoff of pending) {
    if (flushingCallHandoffs.has(handoff.callId)) {
      continue;
    }
    const readiness = await canAttemptCallHandoffAppend(handoff.artifact.boundThreadId);
    if (!readiness.ok) {
      state.updatePendingCallHandoff(handoff.callId, {
        lastError: readiness.reason,
      });
      continue;
    }
    flushingCallHandoffs.add(handoff.callId);
    try {
      const syntheticCall: ActiveCallRecord = {
        callId: handoff.callId,
        bridgeId: config.realtime.bridge_id,
        status: "ended",
        startedAt: handoff.artifact.startedAt,
        updatedAt: handoff.updatedAt,
        endedAt: handoff.artifact.endedAt,
        endedReason: handoff.artifact.endedReason,
        boundThreadId: handoff.artifact.boundThreadId,
        cwd: handoff.artifact.cwd,
        gatewayCallId: null,
        telegramUserId: config.telegram.authorized_chat_id,
        telegramChatInstance: null,
        contextPack: null,
        eventPath: "",
        transcriptPath: handoff.artifact.transcriptPath,
        statePath: "",
        handoffJsonPath: "",
        handoffMarkdownPath: "",
        artifactAppendedAt: null,
        recapMessageId: null,
      };
      if (await callArtifactAlreadyAppended(syntheticCall, handoff.artifact)) {
        state.resolvePendingCallHandoff(handoff.callId);
        continue;
      }
      const result = await attemptCallArtifactAppend(syntheticCall, handoff.artifact);
      if (result.status === "appended") {
        state.resolvePendingCallHandoff(handoff.callId);
        state.updateRecentCallSummary(handoff.callId, {
          handoffQueued: false,
          artifactAppendedAt: Date.now(),
        });
        await telegram.sendMessage(
          handoff.chatId,
          [
            `Queued call handoff ${handoff.callId.slice(0, 8)}... was appended into Codex.`,
            "",
            result.acknowledgement,
          ].join("\n"),
        );
        wakeWorker();
      } else {
        state.updatePendingCallHandoff(handoff.callId, {
          attemptCount: handoff.attemptCount + 1,
          lastError: result.reason,
        });
        continue;
      }
    } catch (error) {
      state.updatePendingCallHandoff(handoff.callId, {
        attemptCount: handoff.attemptCount + 1,
        lastError: error instanceof Error ? error.message : String(error),
      });
      continue;
    } finally {
      flushingCallHandoffs.delete(handoff.callId);
    }
  }
}

interface GenerateAndSendImageOptions {
  replyToMessageId?: number;
  progressMessageId?: number | null;
  naturalLanguage?: boolean;
  finalText?: string;
  metadata?: Record<string, unknown>;
  throwOnFailure?: boolean;
}

async function generateAndSendImage(
  chatId: string,
  prompt: string,
  options: GenerateAndSendImageOptions = {},
): Promise<{ finalText: string; artifact: StoredArtifact | null }> {
  let progressMessageId = options.progressMessageId ?? null;
  if (progressMessageId) {
    await telegram.editMessageText(chatId, progressMessageId, "Generating image...").catch(async () => {
      const progress = await telegram.sendMessage(chatId, "Generating image...", {
        ...(options.replyToMessageId ? { replyToMessageId: options.replyToMessageId } : {}),
      });
      progressMessageId = progress.message_id;
    });
  } else {
    const progress = await telegram.sendMessage(chatId, "Generating image...", {
      ...(options.replyToMessageId ? { replyToMessageId: options.replyToMessageId } : {}),
    });
    progressMessageId = progress.message_id;
  }
  try {
    const result = await withTimeout(
      registry.generateImage({ prompt }),
      DIRECT_IMAGE_GENERATION_TIMEOUT_MS,
      "Timed out generating the image.",
    );
    const artifact = await artifacts.writeArtifact({
      modality: "image",
      providerId: result.providerId,
      source: "telegram",
      buffer: result.buffer,
      fileExtension: result.fileExtension,
      mimeType: result.mimeType,
      metadata: {
        prompt,
        directCommand: !options.naturalLanguage,
        naturalLanguage: options.naturalLanguage ?? false,
        ...(options.metadata ?? {}),
        ...(result.revisedPrompt ? { revisedPrompt: result.revisedPrompt } : {}),
      },
    });
    await deliverImageArtifacts({
      telegram,
      chatId,
      artifacts: [artifact],
      markDelivered: artifactId => state.markArtifactDelivered(artifactId),
      markFailed: (artifactId, error) => state.recordArtifactDeliveryFailure(artifactId, error, { quarantine: true }),
      captionForArtifact: () => "Generated image.",
      onPhotoFallback: (entry, error) => {
        logger.warn("sendPhoto failed for /image command, falling back to sendDocument", {
          artifactId: entry.id,
          error: error instanceof Error ? error.message : String(error),
        });
      },
      onDeliveryFailure: (entry, error) => {
        throw new Error(`Image delivery failed for ${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
      },
    });
    const finalText = options.finalText ?? (
      result.revisedPrompt && result.revisedPrompt !== prompt
        ? `Image generated via ${result.providerId}.\nRevised prompt: ${result.revisedPrompt}`
        : `Image generated via ${result.providerId}.`
    );
    await telegram.editMessageText(chatId, progressMessageId, finalText).catch(async () => {
      await telegram.sendMessage(chatId, finalText);
    });
    return { finalText, artifact };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("image command failed", { chatId, message, prompt });
    const finalText = options.naturalLanguage
      ? "Image generation failed. Please try again."
      : `Image generation failed.\n${sanitizeTelegramErrorText(message)}`;
    await telegram.editMessageText(chatId, progressMessageId, finalText).catch(async () => {
      await telegram.sendMessage(chatId, finalText);
    });
    if (options.throwOnFailure) {
      throw error;
    }
    return { finalText, artifact: null };
  }
}

async function tryHandleDirectImageGenerationTask(
  task: QueuedTelegramTask,
  placeholderMessageId?: number | null,
): Promise<{ status: "not_matched" } | { status: "completed"; finalText: string } | { status: "failed"; errorText: string }> {
  if (task.kind !== "text" && task.kind !== "voice" && task.kind !== "audio") {
    return { status: "not_matched" };
  }
  if (usesCodexNativeImageGeneration()) {
    return { status: "not_matched" };
  }
  const requestText = imageGenerationRequestText(task);
  if (classifyTelegramTurnWorkload(task) !== "image_generation") {
    return { status: "not_matched" };
  }
  const prompt = buildDirectImageGenerationPrompt(requestText);
  try {
    const { finalText } = await generateAndSendImage(task.chatId, prompt, {
      replyToMessageId: task.messageId,
      ...(placeholderMessageId !== undefined ? { progressMessageId: placeholderMessageId } : {}),
      naturalLanguage: true,
      finalText: "Generated image.",
      throwOnFailure: true,
      metadata: {
        taskId: task.id,
        userRequest: requestText,
      },
    });
    await maybeSendAudioReply(task, finalText);
    return { status: "completed", finalText };
  } catch {
    return { status: "failed", errorText: "Image generation failed. Please try again." };
  }
}

async function tryCompleteQueuedDirectImageGenerationTask(
  task: QueuedTelegramTask,
  placeholderMessageId: number | null,
): Promise<boolean> {
  const result = await tryHandleDirectImageGenerationTask(task, placeholderMessageId);
  if (result.status === "not_matched") {
    return false;
  }
  state.updateQueueStatus(task.id, result.status === "completed" ? "completed" : "failed", {
    placeholderMessageId: currentPlaceholderMessageId(task.id, placeholderMessageId),
    errorText: result.status === "completed" ? null : result.errorText,
  });
  return true;
}

function queueHoldReason(): string | null {
  const activeCall = getActiveCall();
  if (callBlocksAsyncWork(activeCall)) {
    return callHoldReason(activeCall);
  }
  if (codex.hasActiveTurn()) {
    return "codex_busy";
  }
  if (state.isSleeping()) {
    return "sleeping";
  }
  const owner = state.getOwner("none");
  if (owner !== "telegram") {
    return `owner:${owner}`;
  }
  const mode = state.getMode(defaultBridgeMode(config));
  if (mode !== "autonomous-thread" && !state.getBoundThread()) {
    return "unbound";
  }
  return null;
}

async function sharedThreadExternalHoldReason(): Promise<string | null> {
  if (state.getMode(defaultBridgeMode(config)) !== "shared-thread-resume") {
    return null;
  }
  const binding = state.getBoundThread();
  if (!binding?.rolloutPath) {
    return null;
  }
  try {
    const activity = await sharedThreadRolloutWatcher.getThreadActivity(binding.rolloutPath);
    if (!activity.activeTurnId) {
      return null;
    }
    const currentActiveTask = state.getActiveTask();
    if (currentActiveTask?.turnId && currentActiveTask.turnId === activity.activeTurnId) {
      return null;
    }
    return "desktop_turn_active";
  } catch (error) {
    logger.warn("failed to inspect shared-thread rollout activity", {
      rolloutPath: binding.rolloutPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return "desktop_turn_unverified";
  }
}

async function currentSharedThreadExternalTurnId(): Promise<string | null> {
  if (state.getMode(defaultBridgeMode(config)) !== "shared-thread-resume") {
    return null;
  }
  const binding = state.getBoundThread();
  if (!binding?.rolloutPath) {
    return null;
  }
  try {
    const activity = await sharedThreadRolloutWatcher.getThreadActivity(binding.rolloutPath);
    if (!activity.activeTurnId) {
      return null;
    }
    const currentActiveTask = state.getActiveTask();
    if (currentActiveTask?.turnId && currentActiveTask.turnId === activity.activeTurnId) {
      return null;
    }
    return activity.activeTurnId;
  } catch (error) {
    logger.warn("failed to inspect shared-thread rollout activity", {
      rolloutPath: binding.rolloutPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return "(unverified)";
  }
}

function describeSharedThreadExternalTurnSummary(turnId: string | null): string | null {
  if (!turnId) {
    return null;
  }
  if (turnId === "(unverified)") {
    return "the bound desktop Codex session activity could not be read safely, so the bridge is treating it as busy";
  }
  return `the bound desktop Codex session is already executing another turn (${turnId})`;
}

async function effectiveQueueHoldReason(): Promise<string | null> {
  const immediate = queueHoldReason();
  if (immediate) {
    return immediate;
  }
  return sharedThreadExternalHoldReason();
}

function codexForLane(lane: BridgeLane): BridgeBackendManager {
  return lane === "fallback" ? fallbackCodex : codex;
}

function fallbackLaneEnabled(): boolean {
  return state.getSetting<boolean | null>("bridge:fallback_lane_enabled_override", null)
    ?? Boolean(config.bridge.fallback_lane?.enabled);
}

function fallbackRoutingPolicy(): { enabled: boolean; allowWorkspaceWrites: boolean } {
  return {
    enabled: fallbackLaneEnabled(),
    allowWorkspaceWrites: config.bridge.fallback_lane?.allow_workspace_writes ?? false,
  };
}

function taskCanUseFallbackWhenHeld(task: QueuedTelegramTask | null, holdReason: string | null): boolean {
  if (!task || activeTask) {
    return false;
  }
  return selectTelegramTaskLane({
    task,
    holdReason,
    policy: fallbackRoutingPolicy(),
  }) === "fallback";
}

async function selectedTaskLane(task: QueuedTelegramTask): Promise<{
  lane: BridgeLane;
  holdReason: string | null;
}> {
  const holdReason = await effectiveQueueHoldReason();
  if (!holdReason) {
    return { lane: "primary", holdReason: null };
  }
  return {
    lane: selectTelegramTaskLane({
      task,
      holdReason,
      policy: fallbackRoutingPolicy(),
    }),
    holdReason,
  };
}

async function ensureFallbackCodexReady(): Promise<void> {
  await fallbackCodex.sync(true, true);
}

async function updateQueuedTaskPlaceholder(
  task: QueuedTelegramTask,
  aheadCount: number,
  holdReason: string | null,
  placeholderMessageId: number | null,
): Promise<number> {
  const queuedText = buildQueuedPlaceholder(task, aheadCount, holdReason);
  if (placeholderMessageId) {
    try {
      await telegram.editMessageText(task.chatId, placeholderMessageId, queuedText);
      state.updateQueueStatus(task.id, "pending", {
        placeholderMessageId,
        errorText: null,
      });
      return placeholderMessageId;
    } catch {
      // Fall through and send a fresh queued placeholder.
    }
  }
  const placeholder = await telegram.sendMessage(task.chatId, queuedText);
  state.updateQueueStatus(task.id, "pending", {
    placeholderMessageId: placeholder.message_id,
    errorText: null,
  });
  return placeholder.message_id;
}

async function effectiveCallStartBlocker(input: {
  surface: RealtimeCallSurfaceRecord;
  activeCall?: ActiveCallRecord | null;
  gatewayReady?: boolean;
  gatewayConnected?: boolean;
  publicSurface?: RealtimePublicSurfaceStatus;
}): Promise<CallStartBlocker | null> {
  const blocker = describeCallStartBlocker(input);
  if (blocker) {
    return blocker;
  }
  const externalTurnId = await currentSharedThreadExternalTurnId();
  const externalTurnSummary = describeSharedThreadExternalTurnSummary(externalTurnId);
  if (externalTurnSummary) {
    return {
      code: "codex_busy",
      summary: externalTurnSummary.charAt(0).toUpperCase() + externalTurnSummary.slice(1),
      nextStep: externalTurnId === "(unverified)"
        ? "Wait for the current desktop turn to finish or repair the rollout file, then retry /call."
        : "Wait for the current desktop turn to finish, then retry /call.",
    };
  }
  return null;
}

function retryableTaskDeferral(message: string): { holdReason: string } | null {
  if (message === "A Codex turn is already in progress.") {
    return {
      holdReason: queueHoldReason() ?? "codex_busy",
    };
  }
  if (
    message.includes("Deferred while enabling live call")
    || message.includes("resend after call is active")
  ) {
    return {
      holdReason: "call_enable_pending",
    };
  }
  return null;
}

async function processQueuedTask(task: QueuedTelegramTask): Promise<void> {
  let effectiveTask = state.getTask(task.id) ?? task;
  let placeholderMessageId = state.getQueueState(task.id)?.placeholderMessageId ?? null;
  const needsImmediatePlaceholder = taskNeedsImmediatePlaceholder(effectiveTask);
  let startedAt = Date.now();
  let selectedLane: BridgeLane = fallbackLaneEnabled() ? effectiveTask.lane ?? "primary" : "primary";
  let turnBackend = codexForLane(selectedLane);
  try {
    if (!placeholderMessageId && needsImmediatePlaceholder) {
      placeholderMessageId = (await telegram.sendMessage(task.chatId, telegramProgressText())).message_id;
    }
    const stagedImage = imageStaging.get(task.id);
    if (stagedImage && placeholderMessageId) {
      await telegram.editMessageText(task.chatId, placeholderMessageId, telegramProgressText("Preparing image."));
      await stagedImage.catch((error: unknown) => {
        logger.warn("image staging failed before task start", {
          taskId: task.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    effectiveTask = state.getTask(task.id) ?? task;
    startedAt = Date.now();
    if (await tryCompleteQueuedTerminalCodexTask(effectiveTask, placeholderMessageId)) {
      return;
    }
    const selection = await selectedTaskLane(effectiveTask);
    selectedLane = selection.lane;
    turnBackend = codexForLane(selectedLane);
    if (selection.holdReason && selectedLane === "primary") {
      state.updateQueueStatus(effectiveTask.id, "pending", {
        placeholderMessageId,
        errorText: null,
      });
      await updateQueuedTaskPlaceholder(effectiveTask, 0, selection.holdReason, placeholderMessageId);
      return;
    }
    if (selectedLane === "fallback" && effectiveTask.lane !== "fallback") {
      effectiveTask = { ...effectiveTask, lane: "fallback" };
      state.replaceTask(effectiveTask);
    }
    if (await tryCompleteQueuedDirectImageGenerationTask(effectiveTask, placeholderMessageId)) {
      return;
    }
    state.updateQueueStatus(effectiveTask.id, "processing", { placeholderMessageId });
    if (selectedLane === "fallback") {
      try {
        await ensureFallbackCodexReady();
      } catch (error) {
        logger.warn("fallback lane was selected but could not start; leaving task queued", {
          taskId: effectiveTask.id,
          error: error instanceof Error ? error.message : String(error),
        });
        state.updateQueueStatus(effectiveTask.id, "pending", {
          placeholderMessageId,
          errorText: null,
        });
        await updateQueuedTaskPlaceholder(effectiveTask, 0, "fallback_unavailable", placeholderMessageId);
        return;
      }
    }
    const inputs = await buildTurnInputs(effectiveTask, placeholderMessageId);
    effectiveTask = state.getTask(effectiveTask.id) ?? effectiveTask;
    if (await tryCompleteQueuedDirectImageGenerationTask(effectiveTask, placeholderMessageId)) {
      return;
    }
    maybeCarryForwardConversationalPreferences(effectiveTask);
    if (placeholderMessageId) {
      await telegram.editMessageText(
        effectiveTask.chatId,
        placeholderMessageId,
        buildTurnStartPlaceholder(turnBackend.getMode()),
      );
    }
    activeTask = {
      task: effectiveTask,
      placeholderMessageId,
      startedAt,
      previewText: null,
      previewPromise: null,
    };
    state.setActiveTask({
      queueId: effectiveTask.id,
      lane: selectedLane,
      chatId: effectiveTask.chatId,
      placeholderMessageId,
      startedAt,
      mode: turnBackend.getMode(),
      stage: "preparing",
      threadId: turnBackend.getThreadId(),
      boundThreadId: turnBackend.getBoundThread()?.threadId ?? null,
      rolloutPath: turnBackend.getBoundThread()?.rolloutPath ?? null,
      turnId: null,
    });
    state.markActiveTaskStage("requesting");
    const result = await turnBackend.startTurn(inputs);
    const finalText = result.finalText || "Codex completed without a final text answer.";
    const deliveryFailures: string[] = [];
    await flushPreviewText(effectiveTask.id);
    const finalPlaceholderMessageId = currentPlaceholderMessageId(effectiveTask.id, placeholderMessageId);
    await sendFinalText(effectiveTask.chatId, finalPlaceholderMessageId, finalText);
    try {
      await stageReferencedGeneratedDocuments(effectiveTask.id, finalText, activeTask.startedAt);
      await stageReferencedGeneratedVideos(effectiveTask.id, finalText, activeTask.startedAt);
      await stageReferencedGeneratedAudio(effectiveTask.id, finalText, activeTask.startedAt);
    } catch (error) {
      deliveryFailures.push("generated files");
      logger.warn("failed to stage generated files", {
        taskId: effectiveTask.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await maybeSendGeneratedImages(effectiveTask.chatId, {
        createdAfter: activeTask.startedAt,
        labelOlderAsRecovered: true,
      });
    } catch (error) {
      deliveryFailures.push("generated images");
      logger.warn("failed to deliver generated images", {
        taskId: effectiveTask.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await maybeSendGeneratedDocuments(effectiveTask.chatId, {
        createdAfter: activeTask.startedAt,
        labelOlderAsRecovered: true,
      });
    } catch (error) {
      deliveryFailures.push("generated documents");
      logger.warn("failed to deliver generated documents", {
        taskId: effectiveTask.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await maybeSendGeneratedVideos(effectiveTask.chatId, {
        createdAfter: activeTask.startedAt,
        labelOlderAsRecovered: true,
      });
    } catch (error) {
      deliveryFailures.push("generated videos");
      logger.warn("failed to deliver generated videos", {
        taskId: effectiveTask.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await maybeSendAudioReply(effectiveTask, finalText);
    } catch (error) {
      deliveryFailures.push("audio reply");
      logger.warn("failed to deliver audio reply", {
        taskId: effectiveTask.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await maybeSendGeneratedAudio(effectiveTask.chatId, {
        createdAfter: activeTask.startedAt,
        labelOlderAsRecovered: true,
      });
    } catch (error) {
      deliveryFailures.push("generated audio");
      logger.warn("failed to deliver generated audio", {
        taskId: effectiveTask.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (deliveryFailures.length > 0) {
      const uniqueFailures = [...new Set(deliveryFailures)];
      await sendDeliveryFailureNotice(effectiveTask.chatId, uniqueFailures.join(", "));
      state.updateQueueStatus(effectiveTask.id, "failed", {
        placeholderMessageId: finalPlaceholderMessageId,
        errorText: `Delivery failed: ${uniqueFailures.join(", ")}`,
      });
      return;
    }
    state.updateQueueStatus(effectiveTask.id, "completed", {
      placeholderMessageId: finalPlaceholderMessageId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const userMessage = sanitizeTelegramErrorText(message);
    const livePlaceholderMessageId = currentPlaceholderMessageId(effectiveTask.id, placeholderMessageId);
    const retryableDeferral = retryableTaskDeferral(message);
    if (retryableDeferral) {
      logger.warn("task deferred for retry", {
        taskId: effectiveTask.id,
        holdReason: retryableDeferral.holdReason,
        message,
      });
      state.updateQueueStatus(effectiveTask.id, "pending", {
        placeholderMessageId: livePlaceholderMessageId,
        errorText: null,
      });
      if (livePlaceholderMessageId) {
        await telegram.editMessageText(
          effectiveTask.chatId,
          livePlaceholderMessageId,
          buildQueuedPlaceholder(effectiveTask, 0, retryableDeferral.holdReason),
        ).catch(async () => {
          await telegram.sendMessage(
            effectiveTask.chatId,
            buildQueuedPlaceholder(effectiveTask, 0, retryableDeferral.holdReason),
          );
        });
      } else {
        const placeholder = await telegram.sendMessage(
          effectiveTask.chatId,
          buildQueuedPlaceholder(effectiveTask, 0, retryableDeferral.holdReason),
        );
        state.updateQueueStatus(effectiveTask.id, "pending", {
          placeholderMessageId: placeholder.message_id,
          errorText: null,
        });
      }
      return;
    }
    logger.error("task failed", { taskId: effectiveTask.id, message });
    if (livePlaceholderMessageId) {
      await telegram.editMessageText(effectiveTask.chatId, livePlaceholderMessageId, `Request failed.\n${userMessage}`)
        .catch(async () => {
          await telegram.sendMessage(effectiveTask.chatId, `Request failed.\n${userMessage}`);
        });
    } else {
      await telegram.sendMessage(effectiveTask.chatId, `Request failed.\n${userMessage}`);
    }
    state.updateQueueStatus(effectiveTask.id, "failed", {
      placeholderMessageId: livePlaceholderMessageId,
      errorText: userMessage,
    });
  } finally {
    state.setActiveTask(null);
    activeTask = null;
  }
}

async function ensureWorker(): Promise<void> {
  if (workerRunning) {
    return;
  }
  workerRunning = true;
  try {
    while (!shutdownRequested) {
      const pendingCallHandoffs = state.getPendingCallHandoffCount();
      const holdReason = await effectiveQueueHoldReason();
      const firstPendingTask = state.nextPendingTask();
      const nextPendingTask = !holdReason
        || taskCanBypassHoldToTerminal(firstPendingTask, holdReason)
        || taskCanUseFallbackWhenHeld(firstPendingTask, holdReason)
        ? firstPendingTask
        : null;
      if (pendingCallHandoffs === 0 && !nextPendingTask) {
        await waitForWorkerWake();
        continue;
      }
      await codex.sync().catch((error: unknown) => {
        logger.warn("backend sync failed", { error: error instanceof Error ? error.message : String(error) });
      });
      if (pendingCallHandoffs > 0) {
        await flushPendingCallHandoffs().catch((error: unknown) => {
          logger.warn("failed to flush pending call handoffs", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      const lateHoldReason = await effectiveQueueHoldReason();
      const latePendingTask = state.nextPendingTask();
      if (
        lateHoldReason
        && !taskCanBypassHoldToTerminal(latePendingTask, lateHoldReason)
        && !taskCanUseFallbackWhenHeld(latePendingTask, lateHoldReason)
      ) {
        await waitForWorkerWake();
        continue;
      }
      const next = latePendingTask;
      if (!next) {
        await waitForWorkerWake();
        continue;
      }
      try {
        await processQueuedTask(next);
      } catch (error) {
        logger.error("queue worker task escape", {
          taskId: next.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    workerRunning = false;
  }
}

async function sendStatus(chatId: string): Promise<void> {
  const status = codex.getStatus();
  const activeCall = getActiveCall();
  const activeTaskRecord = state.getActiveTask();
  const queuedTasks = status.queueCount;
  const pendingCallHandoffs = state.getPendingCallHandoffCount();
  const recentCall = summarizeRecentCall(state.getRecentCallSummary(), config.repoRoot);
  const recentFailedTask = summarizeRecentFailedTask(state.getMostRecentFailedTaskSince(DAEMON_STARTED_AT));
  const surface = await syncManagedTunnelSurface();
  const recentCallEvents = summarizeRecentCallSurfaceEvents(surface);
  const realtimeBudget = getRealtimeBudgetSnapshot(config, state);
  const pendingUserInputCount = Math.max(
    pendingUserInputRequests.size,
    state.getPendingUserInputDiagnosticCount(),
  );
  const publicSurface = await probeRealtimePublicSurface(config, surface, publicSurfaceProbeOptions());
  const gatewayReady = await isRealtimeGatewayReady();
  const gatewayConnected = gatewayClient.isConnected();
  const publicCallReady = gatewayReady && gatewayConnected && publicSurface.ready;
  const publicCallIssue = summarizePublicCallIssue({
    surface,
    gatewayReady,
    gatewayConnected,
    publicSurfaceReady: publicSurface.ready,
    publicSurfaceDetail: publicSurface.detail,
  });
  let callStartBlocker = summarizeCallStartBlocker({
    activeTask: activeTaskRecord,
    activeCall,
    queuedTasks,
    pendingApprovals: status.pendingApprovals,
    pendingCallHandoffs,
    owner: status.owner,
    binding: status.binding,
    desktopTurnId: await currentSharedThreadExternalTurnId(),
    explicitLiveCall: true,
  });
  const liveCallPriority = describeLiveCallPriorityHint({
    activeTask: activeTaskRecord,
    queuedTasks,
    pendingCallHandoffs,
  });
  const blocker = await effectiveCallStartBlocker({
    surface,
    activeCall,
    gatewayReady,
    gatewayConnected,
    publicSurface,
  });
  const lines = [
    "Bridge status",
    `Mode: ${status.mode}`,
    `Owner: ${status.owner}`,
    `Sleeping: ${status.sleeping ? "yes" : "no"}`,
    `Thread: ${status.threadId ? `${status.threadId.slice(0, 12)}...` : "none"}`,
    `Bound: ${status.binding ? `${status.binding.threadId.slice(0, 12)}...` : "none"}`,
    `CWD: ${status.cwd ?? "(none)"}`,
    `Queue: ${status.queueCount}`,
    `Active task: ${status.activeTask ? `${status.activeTask.queueId} (${status.activeTask.stage})` : "none"}`,
    `Active task age: ${activeTaskRecord ? formatAgeSeconds(activeTaskRecord.startedAt) : "none"}`,
    `Recent failed task: ${recentFailedTask.label}`,
    `Pending approvals: ${status.pendingApprovals}`,
    `Pending user input: ${pendingUserInputCount}`,
    `Active call: ${activeCall ? `${activeCall.callId} (${activeCall.status})` : "none"}`,
    `Recent call: ${recentCall.label}`,
    `Pending call handoffs: ${state.getPendingCallHandoffCount()}`,
    `Realtime budget: ${describeRealtimeBudget(realtimeBudget)}`,
    `Gateway: ${gatewayReady ? "ready" : "down"} / ${gatewayConnected ? "bridge-connected" : "bridge-disconnected"}`,
    `Call surface: ${effectiveCallSurfaceStatus(surface, publicCallReady, activeCall)}`,
    `Call surface armed: ${surface.armed ? "yes" : "no"}`,
    `Call surface expires in: ${formatSurfaceExpiry(surface.expiresAt)}`,
    `Public call surface: ${publicCallReady ? "ready" : publicCallIssue}`,
    `Live call blocker: ${callStartBlocker}`,
    `Live-call priority: ${liveCallPriority ?? "none"}`,
    `Recent /call activity: ${recentCallEvents[0] ?? "none"}`,
    `Last public probe: ${surface.lastPublicProbeDetail ? `${surface.lastPublicProbeDetail} @ ${formatTimestamp(surface.lastPublicProbeAt)}` : "none"}`,
    `ASR override: ${state.getProviderOverride("asr") ?? "(default)"}`,
    `TTS override: ${state.getProviderOverride("tts") ?? "(default)"}`,
    `Image override: ${state.getProviderOverride("image_generation") ?? "(default)"}`,
  ];
  if (recentFailedTask.error !== "none") {
    lines.push(`Recent failed task error: ${recentFailedTask.error}`);
  }
  if (recentCall.bundle !== "none") {
    lines.push(`Recent call bundle: ${recentCall.bundle}`);
    lines.push(`Recent call handoff: ${recentCall.appendStatus}`);
  }
  for (const [index, entry] of recentCallEvents.slice(1).entries()) {
    lines.push(`Recent /call activity ${index + 2}: ${entry}`);
  }
  if (blocker && !shouldSuppressExplicitLiveCallBlocker(blocker)) {
    lines.push(`Call start blocker: ${blocker.summary}`);
    lines.push(`Next step: ${blocker.nextStep}`);
  }
  await telegram.sendMessage(chatId, lines.join("\n"));
}

async function sendFallbackStatus(chatId: string): Promise<void> {
  const fallbackStatus = fallbackCodex.getStatus();
  const activeRecord = state.getActiveTask();
  await telegram.sendMessage(chatId, [
    "Fallback lane",
    `Enabled: ${fallbackLaneEnabled() ? "yes" : "no"}`,
    `Routing: ${config.bridge.fallback_lane?.routing ?? "when_desktop_busy_safe"}`,
    `Ready: ${fallbackCodex.getThreadId() ? "yes" : "no"}`,
    `Thread: ${fallbackCodex.getThreadId() ? `${fallbackCodex.getThreadId()!.slice(0, 12)}...` : "none"}`,
    `CWD: ${(fallbackStatus.cwd ?? config.bridge.fallback_lane?.workdir ?? config.codex.workdir) || "(not configured)"}`,
    `Workspace writes: ${config.bridge.fallback_lane?.allow_workspace_writes ? "allowed" : "disabled"}`,
    `Active task: ${activeRecord && (activeRecord.lane ?? "primary") === "fallback" ? `${activeRecord.queueId} (${activeRecord.stage})` : "none"}`,
  ].join("\n"));
}

async function handleFallbackCommand(chatId: string, args: string[]): Promise<void> {
  const action = args[0] ?? "status";
  switch (action) {
    case "status":
      await sendFallbackStatus(chatId);
      return;
    case "enable":
      state.setSetting("bridge:fallback_lane_enabled_override", true);
      wakeWorker();
      await telegram.sendMessage(chatId, "Fallback lane enabled for safe desktop-busy tasks.");
      return;
    case "disable":
      state.setSetting("bridge:fallback_lane_enabled_override", false);
      await fallbackCodex.close().catch((error: unknown) => {
        logger.warn("failed to close fallback lane during disable", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      await telegram.sendMessage(chatId, "Fallback lane disabled.");
      return;
    case "reset":
      await fallbackCodex.close().catch((error: unknown) => {
        logger.warn("failed to close fallback lane during reset", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      state.setSetting("codex:fallback_thread_id", null);
      await telegram.sendMessage(chatId, "Fallback lane thread state reset. It will start fresh on the next eligible fallback task.");
      return;
    default:
      await telegram.sendMessage(chatId, "Usage: /fallback [status|enable|disable|reset]");
  }
}

async function sendWhere(chatId: string): Promise<void> {
  const status = codex.getStatus();
  const binding = status.binding;
  const activeCall = getActiveCall();
  await telegram.sendMessage(chatId, [
    "Session routing",
    `Mode: ${status.mode}`,
    `Owner: ${status.owner}`,
    `Execution cwd: ${status.cwd ?? "(none)"}`,
    `Current thread: ${status.threadId ?? "(none)"}`,
    `Bound thread: ${binding?.threadId ?? "(none)"}`,
    `Bound rollout: ${binding?.rolloutPath ?? "(none)"}`,
    `Bound title: ${binding?.title ?? "(none)"}`,
    `Active call: ${activeCall ? `${activeCall.callId} (${activeCall.status})` : "none"}`,
    `Pending handoffs: ${state.getPendingCallHandoffCount()}`,
  ].join("\n"));
}

async function inspectTeleportThreadActivity(thread: BoundThread): Promise<ThreadTeleportActivity | null> {
  if (!thread.rolloutPath) {
    return null;
  }
  try {
    const activity = await new RolloutWatcher().getThreadActivity(thread.rolloutPath);
    return {
      activeTurnId: activity.activeTurnId,
      lastStartedAt: activity.lastStartedAt,
      lastCompletedAt: activity.lastCompletedAt,
    };
  } catch (error) {
    return {
      activeTurnId: null,
      lastStartedAt: null,
      lastCompletedAt: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function sendThreads(chatId: string, args: string[]): Promise<void> {
  const cwd = args[0] ? resolve(args[0]) : undefined;
  const threads = locator.listMatchingDesktopThreads({
    ...(cwd ? { cwd } : {}),
    limit: 10,
  });
  if (threads.length === 0) {
    await telegram.sendMessage(chatId, cwd
      ? `No desktop Codex threads found for ${cwd}.`
      : "No desktop Codex threads found.");
    return;
  }
  const activities = new Map<string, ThreadTeleportActivity | null>();
  await Promise.all(threads.map(async thread => {
    activities.set(thread.threadId, await inspectTeleportThreadActivity(thread));
  }));
  await telegram.sendMessage(chatId, renderThreadTeleportList({
    threads,
    boundThreadId: state.getBoundThread()?.threadId ?? null,
    cwdLabel: cwd ?? null,
    activities,
  }));
}

async function sendProviders(chatId: string): Promise<void> {
  const statuses = await registry.getProviderStatuses();
  const lines = [
    "Providers",
    `ASR chain: ${registry.getEffectiveChain("asr").join(" -> ")}`,
    `TTS chain: ${registry.getEffectiveChain("tts").join(" -> ")}`,
    `Image chain: ${registry.getEffectiveChain("image_generation").join(" -> ")}`,
    "",
  ];
  for (const modality of ["asr", "tts", "image_generation"] as const satisfies Modality[]) {
    const entries = statuses[modality];
    lines.push(`${modality}:`);
    for (const entry of entries) {
      lines.push(`- ${entry.id}: ${entry.available ? "available" : "unavailable"} (${entry.detail})`);
    }
  }
  await telegram.sendMessage(chatId, lines.join("\n"));
}

async function sendCapabilities(chatId: string): Promise<void> {
  const status = codex.getStatus();
  const callStartState = await inspectCallStartState();
  const surface = await syncManagedTunnelSurface();
  const publicSurface = await probeRealtimePublicSurface(config, surface, publicSurfaceProbeOptions());
  const gatewayReady = await isRealtimeGatewayReady();
  const gatewayConnected = gatewayClient.isConnected();
  const lines = renderCapabilityLines(
    config,
    env,
    state,
    {
      runtime: {
        mode: status.mode,
        owner: status.owner,
        binding: status.binding,
        threadId: status.threadId,
        cwd: status.cwd,
        daemonRunning: true,
        gatewayReady,
        gatewayBridgeReady: gatewayConnected,
        realtimePublicReady: gatewayReady && gatewayConnected && publicSurface.ready,
        realtimePublicDetail: gatewayReady && gatewayConnected && publicSurface.ready
          ? null
          : summarizePublicCallIssue({
            surface,
            gatewayReady,
            gatewayConnected,
            publicSurfaceReady: publicSurface.ready,
            publicSurfaceDetail: publicSurface.detail,
          }),
        launchTokenReady: launchTokenReadyForCurrentBridge(surface),
        realtimeStartBlocker: callStartState.blocker
          && !shouldSuppressExplicitLiveCallBlocker(callStartState.blocker)
          ? callStartState.blocker.summary
          : null,
      },
      chains: {
        asr: registry.getEffectiveChain("asr"),
        tts: registry.getEffectiveChain("tts"),
        image_generation: registry.getEffectiveChain("image_generation"),
      },
      providerStatuses: await registry.getProviderStatuses(),
    },
    { audience: "telegram" },
  );
  for (const part of splitForTelegram(lines.join("\n"))) {
    await telegram.sendMessage(chatId, part);
  }
}

async function sendInbox(chatId: string): Promise<void> {
  const tasks = state.listPendingTasks(10);
  const failedTasks = state.listRecentFailedTasks(5);
  const approvalCount = state.getPendingApprovalCount();
  const userInputCount = pendingUserInputRequests.size;
  const activeCall = getActiveCall();
  const callInboxCount = activeCall ? state.getCallInboxCount(activeCall.callId) : 0;
  const pendingHandoffs = state.listPendingCallHandoffs();
  if (tasks.length === 0 && failedTasks.length === 0 && approvalCount === 0 && userInputCount === 0 && callInboxCount === 0 && pendingHandoffs.length === 0) {
    await telegram.sendMessage(chatId, "No queued Telegram tasks or pending approvals.");
    return;
  }
  const lines = ["Inbox"];
  if (tasks.length > 0) {
    lines.push("");
    lines.push("Queued tasks:");
    for (const task of tasks) {
      const summary = task.text.replace(/\s+/g, " ").slice(0, 120);
      lines.push(`- ${task.id} | ${task.kind} | ${summary}`);
    }
  }
  if (failedTasks.length > 0) {
    lines.push("");
    lines.push("Recent failed tasks:");
    for (const task of failedTasks) {
      const summary = task.text.replace(/\s+/g, " ").slice(0, 120);
      lines.push(`- ${task.id} | ${task.kind} | ${summary}`);
    }
  }
  if (approvalCount > 0) {
    lines.push("");
    lines.push(`Pending approvals: ${approvalCount}`);
  }
  if (userInputCount > 0) {
    lines.push("");
    lines.push(`Pending user input requests: ${userInputCount}`);
  }
  if (callInboxCount > 0) {
    lines.push("");
    lines.push(`Live call inbox items: ${callInboxCount}`);
  }
  if (pendingHandoffs.length > 0) {
    lines.push("");
    lines.push("Pending call handoffs:");
    for (const handoff of pendingHandoffs.slice(0, 5)) {
      lines.push(`- ${handoff.callId} | attempts=${handoff.attemptCount} | lastError=${handoff.lastError ?? "(none)"}`);
    }
  }
  await telegram.sendMessage(chatId, lines.join("\n"));
}

async function applyBinding(binding: BoundThread | null): Promise<void> {
  await codex.setBoundThread(binding);
}

function previousTeleportBinding(): BoundThread | null {
  return state.getSetting<BoundThread | null>(TELEGRAM_PREVIOUS_BOUND_THREAD_KEY, null);
}

function requirePreviousTeleportBinding(): BoundThread {
  const previous = previousTeleportBinding();
  if (!previous) {
    throw new Error("No previous bound thread is recorded for /teleport back.");
  }
  return previous;
}

function rememberPreviousTeleportBinding(previous: BoundThread | null, next: BoundThread): void {
  if (previous && previous.threadId !== next.threadId) {
    state.setSetting(TELEGRAM_PREVIOUS_BOUND_THREAD_KEY, previous);
  }
}

async function assertTeleportTargetReady(binding: BoundThread): Promise<void> {
  const activity = await inspectTeleportThreadActivity(binding);
  if (!activity || activity.error) {
    throw new Error(
      `Could not verify desktop thread ${binding.threadId.slice(0, 12)}... is idle. Open /threads and try again once its rollout is readable.`,
    );
  }
  if (
    activity.activeTurnId
    || (activity.lastStartedAt && (!activity.lastCompletedAt || activity.lastStartedAt > activity.lastCompletedAt))
  ) {
    throw new Error(
      `Desktop thread ${binding.threadId.slice(0, 12)}... is active. Wait for that Codex turn to finish before attaching Telegram there.`,
    );
  }
}

async function teleportToBinding(binding: BoundThread): Promise<{
  binding: BoundThread;
  previousBinding: BoundThread | null;
  status: ReturnType<typeof codex.getStatus>;
}> {
  const previousBinding = state.getBoundThread();
  const previousMode = codex.getMode();
  const previousOwner = codex.getOwner();
  await assertTeleportTargetReady(binding);
  try {
    codex.setOwner("telegram");
    await applyBinding(binding);
    if (codex.getMode() !== "shared-thread-resume") {
      await codex.setMode("shared-thread-resume");
    }
    wakeWorker();
    await gatewayClient.sendStatus(gatewayStatusPayload()).catch(() => undefined);
    const status = codex.getStatus();
    if (status.mode !== "shared-thread-resume") {
      throw new Error(`Attach verification failed: bridge mode is ${status.mode}, not shared-thread-resume.`);
    }
    if (status.owner !== "telegram") {
      throw new Error(`Attach verification failed: owner is ${status.owner}, not telegram.`);
    }
    if (status.binding?.threadId !== binding.threadId) {
      throw new Error(`Attach verification failed: bound thread is ${status.binding?.threadId ?? "none"}.`);
    }
    rememberPreviousTeleportBinding(previousBinding, binding);
    return { binding, previousBinding, status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("thread attach failed; restoring previous binding", {
      targetThreadId: binding.threadId,
      previousThreadId: previousBinding?.threadId ?? null,
      previousMode,
      previousOwner,
      error: message,
    });
    codex.setOwner(previousOwner);
    await applyBinding(previousBinding).catch((restoreError: unknown) => {
      logger.error("failed to restore previous binding after attach failure", {
        previousThreadId: previousBinding?.threadId ?? null,
        error: restoreError instanceof Error ? restoreError.message : String(restoreError),
      });
    });
    await codex.setMode(previousMode).catch((restoreError: unknown) => {
      logger.error("failed to restore previous mode after attach failure", {
        previousMode,
        error: restoreError instanceof Error ? restoreError.message : String(restoreError),
      });
    });
    throw error;
  }
}

async function teleportCurrent(args: string[]) {
  const cwd = args[0] ? resolve(args[0]) : undefined;
  const binding = locator.bindCurrent({
    ...(cwd ? { cwd } : {}),
  });
  return await teleportToBinding(binding);
}

async function teleportThread(threadId: string) {
  const binding = locator.findById(threadId);
  if (!binding) {
    throw new Error(`Desktop thread ${threadId} was not found.`);
  }
  return await teleportToBinding(binding);
}

async function requireIdleControlOperation(): Promise<void> {
  const activeCall = getActiveCall();
  if (callBlocksAsyncWork(activeCall)) {
    throw new Error(
      isCallLive(activeCall)
        ? "A live call is active. Use /hangup first or force the operation through a future control path."
        : "A completed live call is still being written back into Codex. Wait for cleanup to finish first.",
    );
  }
  if (activeTask || codex.hasActiveTurn()) {
    throw new Error("Wait for the current task to finish before changing mode or binding.");
  }
  if (await currentSharedThreadExternalTurnId()) {
    throw new Error("Wait for the current desktop Codex turn to finish before changing mode or binding.");
  }
  const queuedTasks = state.getQueuedTaskCount();
  if (queuedTasks > 0) {
    throw new Error("Wait for the queued Telegram inbox to drain before changing mode or binding. Use /inbox or /status first.");
  }
  const pendingApprovals = state.getPendingApprovalCount();
  if (pendingApprovals > 0) {
    throw new Error("Resolve pending approvals before changing mode or binding.");
  }
  const pendingCallHandoffs = state.getPendingCallHandoffCount();
  if (pendingCallHandoffs > 0) {
    throw new Error("Wait for the pending live-call handoff to be appended into Codex before changing mode, binding, or ownership.");
  }
}

async function requireReadyForCallStart(options?: {
  explicit?: boolean;
  reason?: string;
  bootstrap?: boolean;
}): Promise<void> {
  if (!config.realtime.enabled) {
    throw new Error("Realtime calling is disabled in bridge.config.toml.");
  }
  if (!await isRealtimeGatewayReady()) {
    throw new Error("The realtime gateway is not healthy.");
  }
  if (!gatewayClient.isConnected()) {
    throw new Error("The realtime gateway control channel is not connected.");
  }
  const surface = await syncManagedTunnelSurface();
  if (!surface.armed) {
    throw new Error("Live calling is disarmed. Send `/call enable` first.");
  }
  const publicSurface = await probeRealtimePublicSurface(config, surface, publicSurfaceProbeOptions());
  if (!publicSurface.ready) {
    throw new Error(`The public Mini App is not reachable. ${publicSurface.detail}`);
  }
  const activeCall = getActiveCall();
  const usage = state.getRealtimeUsage();
  const remainingBudgetMs = Math.max(0, config.realtime.max_daily_call_ms - usage.totalCallMs);
  const maxCallMs = Math.min(config.realtime.max_call_ms, remainingBudgetMs);
  if (maxCallMs <= 0) {
    throw new Error(
      `Today's realtime call budget is exhausted (${Math.round(usage.totalCallMs / 1000)}s used of `
      + `${Math.round(config.realtime.max_daily_call_ms / 1000)}s).`,
    );
  }
  const blocker = options?.bootstrap
    ? (await inspectExplicitLiveCallBootstrapState(options.reason ?? "explicit live call bootstrap")).blocker
    : options?.explicit
      ? (await inspectExplicitLiveCallStartState(options.reason ?? "explicit live call")).blocker
      : await effectiveCallStartBlocker({
      surface,
      activeCall,
      gatewayReady: true,
      gatewayConnected: true,
      publicSurface,
      });
  if (blocker) {
    await notifyCallStartBlocked(blocker);
    throw new Error(`${blocker.summary} ${blocker.nextStep}`);
  }
}

async function requestShutdown(source: string): Promise<void> {
  if (shutdownRequested) {
    return;
  }
  shutdownRequested = true;
  await disarmCallSurfaceLifecycle(`shutdown:${source}`).catch(() => undefined);
  pollAbortController?.abort();
  wakeWorker();
  const hint = source === "SIGTERM" || source === "SIGINT"
    ? state.consumeShutdownHint()
    : null;
  logger.info("shutdown requested", {
    source,
    initiatedBy: hint?.initiatedBy ?? null,
    shutdownDetails: hint?.details ?? null,
  });
}

function spawnDetachedBridgeClaim(threadId: string): void {
  const bridgectlPath = join(entryDir, "bridgectl.js");
  const child = spawn(process.execPath, [bridgectlPath, "claim", threadId], {
    cwd: repoRoot,
    detached: true,
    env: process.env,
    stdio: "ignore",
  });
  child.unref();
}

async function handleTelegramControlIntent(message: TelegramMessage, intent: TelegramControlIntent): Promise<void> {
  const chatId = String(message.chat.id);
  switch (intent) {
    case "reconnect": {
      await requireIdleControlOperation();
      const binding = state.getBoundThread();
      if (!binding) {
        throw new Error("No desktop Codex thread is currently bound, so there is nothing to reconnect yet.");
      }
      await telegram.sendMessage(
        chatId,
        "Reconnecting the bridge to the bound desktop thread...",
        { replyToMessageId: message.message_id },
      );
      logger.info("telegram conversational reconnect requested", {
        chatId: message.chat.id,
        threadId: binding.threadId,
      });
      spawnDetachedBridgeClaim(binding.threadId);
      return;
    }
  }
}

function terminalActiveTaskToPersisted(task: NonNullable<typeof activeTerminalTask>): PersistedTerminalTask {
  const askStart = task.askStart ? persistableTerminalCodexAskStart(task.askStart) : null;
  return {
    id: task.id,
    chatId: task.chatId,
    prompt: task.prompt,
    placeholderMessageId: task.placeholderMessageId,
    startedAt: task.startedAt,
    askStart,
    source: task.source,
    queueId: task.queueId,
  };
}

function persistActiveTerminalTask(): void {
  state.setSetting<PersistedTerminalTask | null>(
    TERMINAL_ACTIVE_TASK_KEY,
    activeTerminalTask ? terminalActiveTaskToPersisted(activeTerminalTask) : null,
  );
}

function setActiveTerminalTask(task: NonNullable<typeof activeTerminalTask> | null): void {
  activeTerminalTask = task;
  persistActiveTerminalTask();
}

function clearActiveTerminalTask(reason: string): void {
  const task = activeTerminalTask;
  if (task?.queueId) {
    state.updateQueueStatus(task.queueId, "cancelled", {
      placeholderMessageId: task.placeholderMessageId,
      errorText: reason,
    });
  }
  setActiveTerminalTask(null);
}

function terminalChatModeEnabled(): boolean {
  return state.getSetting<boolean>(TELEGRAM_TERMINAL_CHAT_MODE_KEY, false);
}

function setTerminalChatModeEnabled(value: boolean): void {
  state.setSetting(TELEGRAM_TERMINAL_CHAT_MODE_KEY, value);
}

function terminalConversationAllowsWorkspaceWrites(): boolean {
  const identity = terminalCodexIdentity(state);
  const profile = identity?.profile ?? config.terminal_lane.profile;
  const sandbox = identity?.sandbox ?? config.terminal_lane.sandbox;
  return profile === "power-user" && sandbox === "workspace-write";
}

function recoverPersistedTerminalTask(): void {
  const persisted = state.getSetting<PersistedTerminalTask | null>(TERMINAL_ACTIVE_TASK_KEY, null);
  if (!persisted) {
    return;
  }
  if (persisted.askStart) {
    state.setSetting<PersistedTerminalTask | null>(TERMINAL_ACTIVE_TASK_KEY, null);
    if (persisted.queueId) {
      state.updateQueueStatus(persisted.queueId, "failed", {
        placeholderMessageId: persisted.placeholderMessageId,
        errorText: "Terminal task was interrupted after being submitted; retry it explicitly after checking terminal status.",
      });
    }
    void telegram.editMessageText(
      persisted.chatId,
      persisted.placeholderMessageId,
      "Terminal task was interrupted by a bridge restart after it was submitted. I did not replay it automatically because terminal scrollback is not persisted. Check /terminal status, then retry explicitly.",
    ).catch((error: unknown) => {
      logger.warn("failed to mark persisted terminal task interrupted", {
        taskId: persisted.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return;
  }
  activeTerminalTask = { ...persisted, askStart: null };
  void runTerminalAskTask(persisted.id).catch((error: unknown) => {
    logger.error("persisted terminal Codex task recovery failed", {
      taskId: persisted.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

function renderActiveTerminalTaskSummary(): string {
  const identity = terminalCodexIdentity(state);
  const identityLine = identity
    ? `Locked: ${identity.backend} ${identity.tty ?? identity.paneId ?? identity.name} (${identity.daemonOwned ? "daemon-owned" : "user-owned"})`
    : "Locked: none";
  if (!activeTerminalTask) {
    return [
      identityLine,
      "Active task: none",
    ].join("\n");
  }
  return [
    identityLine,
    `Active task: ${activeTerminalTask.id.slice(0, 8)} (${formatAgeSeconds(activeTerminalTask.startedAt)})`,
    `Backend: ${activeTerminalTask.askStart?.backend ?? "pending"}`,
    `TTY: ${activeTerminalTask.askStart?.session.tty ?? "pending"}`,
    `Pane: ${activeTerminalTask.askStart?.session.paneId ?? "none"}`,
    `Marker: ${activeTerminalTask.askStart?.marker ?? "pending"}`,
  ].join("\n");
}

async function sendTerminalTaskText(chatId: string, placeholderMessageId: number, text: string): Promise<void> {
  const cleanedText = sanitizeTelegramFinalText(text).trim() || "(no terminal answer captured)";
  const parts = splitForTelegram(cleanedText);
  let remaining = parts;
  try {
    await telegram.editMessageText(chatId, placeholderMessageId, parts[0]!);
    remaining = parts.slice(1);
  } catch (error) {
    logger.warn("failed to edit terminal task placeholder", {
      chatId,
      placeholderMessageId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  for (const part of remaining) {
    await telegram.sendMessage(chatId, part);
  }
}

async function runTerminalAskTask(taskId: string): Promise<void> {
  const task = activeTerminalTask;
  if (!task || task.id !== taskId) {
    return;
  }
  let succeeded = false;
  try {
    await ensureTerminalCodexIdentity(config, state);
    const askStart = task.askStart ?? await startTerminalCodexAsk(task.prompt, config, state);
    if (!activeTerminalTask || activeTerminalTask.id !== taskId) {
      return;
    }
    activeTerminalTask.askStart = askStart;
    persistActiveTerminalTask();
    await telegram.editMessageText(task.chatId, task.placeholderMessageId, [
      "Terminal Codex is working.",
      `Backend: ${askStart.backend}`,
      `Session: ${askStart.session.name}`,
      `TTY: ${askStart.session.tty ?? "none"}`,
      `Pane: ${askStart.session.paneId ?? "none"}`,
      `Marker: ${askStart.marker}`,
    ].join("\n")).catch(() => undefined);
    const result = await waitForTerminalCodexAskCompletion(askStart, config, state, {
      timeoutMs: 10 * 60_000,
      pollIntervalMs: 1_000,
    });
    if (!result.observed) {
      await sendTerminalTaskText(task.chatId, task.placeholderMessageId, [
        "Terminal Codex task timed out before the completion marker appeared.",
        `Marker: ${result.marker}`,
        `Session: ${result.session.name}`,
        `TTY: ${result.session.tty ?? "none"}`,
        `Pane: ${result.session.paneId ?? "none"}`,
        "The terminal session may still be running; check it before sending another terminal task.",
      ].join("\n"));
      return;
    }
    const answerText = result.answerText?.trim() || "Terminal Codex finished, but I could not isolate a final answer from the pane.";
    await sendTerminalTaskText(task.chatId, task.placeholderMessageId, [
      "Terminal Codex answer:",
      "",
      answerText,
      "",
      `Elapsed: ${Math.round(result.elapsedMs / 1000)}s`,
    ].join("\n"));
    try {
      await stageReferencedGeneratedDocuments(task.id, answerText, task.startedAt);
      await stageReferencedGeneratedImages(answerText, task.startedAt);
      await stageReferencedGeneratedVideos(task.id, answerText, task.startedAt);
      await stageReferencedGeneratedAudio(task.id, answerText, task.startedAt);
      await maybeSendGeneratedDocuments(task.chatId, { createdAfter: task.startedAt, labelOlderAsRecovered: true });
      await maybeSendGeneratedImages(task.chatId, { createdAfter: task.startedAt, labelOlderAsRecovered: true });
      await maybeSendGeneratedVideos(task.chatId, { createdAfter: task.startedAt, labelOlderAsRecovered: true });
      await maybeSendGeneratedAudio(task.chatId, { createdAfter: task.startedAt, labelOlderAsRecovered: true });
    } catch (error) {
      logger.warn("failed to deliver terminal Codex generated artifacts", {
        taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    succeeded = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sendTerminalTaskText(task.chatId, task.placeholderMessageId, `Terminal Codex task failed.\n${sanitizeTelegramErrorText(message)}`);
  } finally {
    if (task.queueId) {
      state.updateQueueStatus(task.queueId, succeeded ? "completed" : "failed", {
        placeholderMessageId: task.placeholderMessageId,
        errorText: succeeded ? null : "terminal Codex task failed",
      });
    }
    if (activeTerminalTask?.id === taskId) {
      setActiveTerminalTask(null);
    }
    wakeWorker();
  }
}

async function startTerminalAskFromTelegram(chatId: string, prompt: string, replyToMessageId?: number): Promise<void> {
  if (activeTerminalTask) {
    await telegram.sendMessage(chatId, [
      "Terminal Codex lane is already running a task.",
      renderActiveTerminalTaskSummary(),
    ].join("\n"), replyToMessageId ? { replyToMessageId } : undefined);
    return;
  }
  const placeholder = await telegram.sendMessage(chatId, "Terminal Codex task starting...", replyToMessageId ? { replyToMessageId } : undefined);
  const taskId = randomUUID();
  setActiveTerminalTask({
    id: taskId,
    chatId,
    prompt,
    placeholderMessageId: placeholder.message_id,
    startedAt: Date.now(),
    askStart: null,
    source: "command",
    queueId: null,
  });
  void runTerminalAskTask(taskId).catch((error: unknown) => {
    logger.error("terminal Codex task escaped", {
      taskId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

function terminalWorkCommandBlocker(): string | null {
  const activeCall = getActiveCall();
  if (callBlocksAsyncWork(activeCall)) {
    return callHoldReason(activeCall);
  }
  if (state.getPendingApprovalCount() > 0) {
    return "pending approvals";
  }
  if (state.getPendingCallHandoffCount() > 0) {
    return "pending live-call handoff";
  }
  if (state.isSleeping()) {
    return "bridge is sleeping";
  }
  const owner = state.getOwner("none");
  if (owner !== "telegram") {
    return `owner is ${owner}`;
  }
  return null;
}

function taskTerminalIntent(task: QueuedTelegramTask): TelegramTerminalIntent | null {
  return task.kind === "text" ? detectTelegramTerminalIntent(task.text) : null;
}

function taskCanBypassHoldToTerminal(task: QueuedTelegramTask | null, holdReason: string | null): boolean {
  if (!task || activeTerminalTask) {
    return false;
  }
  const terminalChatMode = terminalChatModeEnabled();
  if (!terminalRouteCanBypassHold(holdReason, { terminalConversationMode: terminalChatMode })) {
    return false;
  }
  if (taskTerminalIntent(task)) {
    return true;
  }
  return selectTerminalRouteForTask(task, {
    desktopBusy: holdReason === "desktop_turn_active",
    terminalBusy: Boolean(activeTerminalTask),
    terminalConversationMode: terminalChatMode,
  }).route === "terminal";
}

async function ensureDocumentTaskStagedForTerminal(
  task: QueuedTelegramTask,
  placeholderMessageId: number | null,
): Promise<QueuedTelegramTask> {
  if (task.kind !== "document") {
    return task;
  }
  validateTelegramTaskForProcessing(task);
  const documentPath = task.documentPath && existsSync(task.documentPath)
    ? task.documentPath
    : documentDownloadPathForTask(task, inboundRoot);
  if (!existsSync(documentPath)) {
    if (!placeholderMessageId) {
      throw new Error("Document task progress requires a Telegram placeholder message.");
    }
    await telegram.editMessageText(task.chatId, placeholderMessageId, telegramProgressText("Downloading file."));
    await telegram.downloadFile(task.documentFileId!, documentPath, {
      maxBytes: MAX_DOCUMENT_INPUT_BYTES,
      timeoutMs: TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
    });
  }
  const updatedTask = { ...task, documentPath };
  state.replaceTask(updatedTask);
  return updatedTask;
}

async function tryCompleteQueuedTerminalCodexTask(task: QueuedTelegramTask, placeholderMessageId: number | null): Promise<boolean> {
  const intent = taskTerminalIntent(task);
  if (intent === "connect" || intent === "disconnect") {
    return false;
  }
  const holdReason = await effectiveQueueHoldReason();
  const terminalChatMode = terminalChatModeEnabled();
  const routeDecision = intent
    ? { route: "terminal" as const, reason: `terminal_${intent}` }
    : selectTerminalRouteForTask(task, {
      desktopBusy: holdReason === "desktop_turn_active",
      terminalBusy: Boolean(activeTerminalTask),
      terminalConversationMode: terminalChatMode,
    });
  if (routeDecision.route !== "terminal") {
    return false;
  }
  const workBlocker = terminalWorkCommandBlocker();
  if (workBlocker) {
    const blockedText = `Terminal Codex lane is blocked right now: ${workBlocker}.`;
    if (placeholderMessageId) {
      await telegram.editMessageText(task.chatId, placeholderMessageId, blockedText).catch(async () => {
        await telegram.sendMessage(task.chatId, blockedText);
      });
    } else {
      await telegram.sendMessage(task.chatId, blockedText);
    }
    state.updateQueueStatus(task.id, "failed", {
      placeholderMessageId,
      errorText: `terminal Codex lane blocked: ${workBlocker}`,
    });
    return true;
  }
  if (activeTerminalTask) {
    const busyText = [
      "Terminal Codex lane is busy.",
      renderActiveTerminalTaskSummary(),
    ].join("\n");
    if (placeholderMessageId) {
      await telegram.editMessageText(task.chatId, placeholderMessageId, busyText).catch(async () => {
        await telegram.sendMessage(task.chatId, busyText);
      });
    } else {
      await telegram.sendMessage(task.chatId, busyText);
    }
    state.updateQueueStatus(task.id, "failed", {
      placeholderMessageId,
      errorText: "terminal Codex lane is busy",
    });
    return true;
  }
  if (intent === "ask") {
    const prompt = extractTelegramTerminalAskText(task.text);
    if (!prompt) {
      return false;
    }
    if (prompt.length > 4_000) {
      const tooLongText = "Terminal prompt is too long for this path. Keep it under 4000 characters.";
      if (placeholderMessageId) {
        await telegram.editMessageText(task.chatId, placeholderMessageId, tooLongText).catch(async () => {
          await telegram.sendMessage(task.chatId, tooLongText);
        });
      } else {
        await telegram.sendMessage(task.chatId, tooLongText);
      }
      state.updateQueueStatus(task.id, "failed", {
        placeholderMessageId,
        errorText: "terminal prompt too long",
      });
      return true;
    }
    if (isTerminalUnsafeRequest(prompt)) {
      const unsafeText = "Terminal Codex lane is read-only/artifact-only for explicit terminal asks. Send mutation, install, deploy, secret, live-call, image-generation, or desktop-control work to the bound desktop bridge path instead.";
      if (placeholderMessageId) {
        await telegram.editMessageText(task.chatId, placeholderMessageId, unsafeText).catch(async () => {
          await telegram.sendMessage(task.chatId, unsafeText);
        });
      } else {
        await telegram.sendMessage(task.chatId, unsafeText);
      }
      state.updateQueueStatus(task.id, "failed", {
        placeholderMessageId,
        errorText: "terminal ask rejected by safety policy",
      });
      return true;
    }
    let livePlaceholderMessageId = placeholderMessageId;
    if (!livePlaceholderMessageId) {
      livePlaceholderMessageId = (await telegram.sendMessage(task.chatId, "Routing this request to terminal Codex.")).message_id;
    } else {
      await telegram.editMessageText(task.chatId, livePlaceholderMessageId, "Routing this request to terminal Codex.")
        .catch(async () => {
          livePlaceholderMessageId = (await telegram.sendMessage(task.chatId, "Routing this request to terminal Codex.")).message_id;
        });
    }
    state.updateQueueStatus(task.id, "processing", { placeholderMessageId: livePlaceholderMessageId });
    setActiveTerminalTask({
      id: randomUUID(),
      chatId: task.chatId,
      prompt: buildTerminalPromptForText(prompt),
      placeholderMessageId: livePlaceholderMessageId,
      startedAt: Date.now(),
      askStart: null,
      source: "queue",
      queueId: task.id,
    });
    await runTerminalAskTask(activeTerminalTask!.id);
    return true;
  }
  if (!intent) {
    let livePlaceholderMessageId = placeholderMessageId;
    const terminalChatRoute = routeDecision.reason === "terminal_chat_mode" || routeDecision.reason === "terminal_chat_document";
    if (terminalChatRoute && task.kind === "text") {
      const blocker = terminalConversationBlocker(task.text, {
        allowWorkspaceWrites: terminalConversationAllowsWorkspaceWrites(),
      });
      if (blocker) {
        if (placeholderMessageId) {
          await telegram.editMessageText(task.chatId, placeholderMessageId, blocker).catch(async () => {
            await telegram.sendMessage(task.chatId, blocker);
          });
        } else {
          await telegram.sendMessage(task.chatId, blocker);
        }
        state.updateQueueStatus(task.id, "failed", {
          placeholderMessageId,
          errorText: blocker,
        });
        return true;
      }
    }
    const routingText = terminalChatRoute
      ? "Terminal chat mode is active; routing this to terminal Codex."
      : "Routing this read-only request to terminal Codex because the bound desktop turn is busy.";
    if (!livePlaceholderMessageId) {
      livePlaceholderMessageId = (await telegram.sendMessage(task.chatId, routingText)).message_id;
    } else {
      await telegram.editMessageText(task.chatId, livePlaceholderMessageId, routingText)
        .catch(async () => {
          livePlaceholderMessageId = (await telegram.sendMessage(task.chatId, routingText)).message_id;
        });
    }
    const stagedTask = await ensureDocumentTaskStagedForTerminal(task, livePlaceholderMessageId);
    state.updateQueueStatus(stagedTask.id, "processing", { placeholderMessageId: livePlaceholderMessageId });
    setActiveTerminalTask({
      id: randomUUID(),
      chatId: stagedTask.chatId,
      prompt: terminalChatRoute
        ? buildTerminalConversationPromptForTask(stagedTask, {
          allowWorkspaceWrites: terminalConversationAllowsWorkspaceWrites(),
        })
        : buildTerminalPromptForTask(stagedTask),
      placeholderMessageId: livePlaceholderMessageId,
      startedAt: Date.now(),
      askStart: null,
      source: "queue",
      queueId: stagedTask.id,
    });
    await runTerminalAskTask(activeTerminalTask!.id);
    return true;
  }
  let livePlaceholderMessageId = placeholderMessageId;
  if (!livePlaceholderMessageId) {
    livePlaceholderMessageId = (await telegram.sendMessage(task.chatId, "Pinging the verified terminal Codex lane...")).message_id;
  } else {
    await telegram.editMessageText(task.chatId, livePlaceholderMessageId, "Pinging the verified terminal Codex lane...")
      .catch(async () => {
        livePlaceholderMessageId = (await telegram.sendMessage(task.chatId, "Pinging the verified terminal Codex lane...")).message_id;
      });
  }
  state.updateQueueStatus(task.id, "processing", { placeholderMessageId: livePlaceholderMessageId });
  try {
    const result = await pingTerminalCodex(config, state, { timeoutMs: 90_000, pollIntervalMs: 1_000 });
    const text = result.observed
      ? [
        "Terminal Codex lane replied.",
        `Marker: ${result.marker}`,
        `Backend: ${result.session.backend}`,
        `Session: ${result.session.name}`,
        `TTY: ${result.session.tty ?? "none"}`,
        `Pane: ${result.session.paneId ?? "none"}`,
        `Elapsed: ${Math.round(result.elapsedMs / 1000)}s`,
      ].join("\n")
      : [
        "Terminal Codex lane did not produce the expected marker before timeout.",
        `Marker: ${result.marker}`,
        `Backend: ${result.session.backend}`,
        `Session: ${result.session.name}`,
        `TTY: ${result.session.tty ?? "none"}`,
        `Pane: ${result.session.paneId ?? "none"}`,
      ].join("\n");
    await telegram.editMessageText(task.chatId, livePlaceholderMessageId, text)
      .catch(async () => {
        await telegram.sendMessage(task.chatId, text);
      });
    state.updateQueueStatus(task.id, result.observed ? "completed" : "failed", {
      placeholderMessageId: livePlaceholderMessageId,
      errorText: result.observed ? null : "terminal Codex ping timed out",
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const userMessage = sanitizeTelegramErrorText(message);
    await telegram.editMessageText(task.chatId, livePlaceholderMessageId, `Terminal Codex lane failed.\n${userMessage}`)
      .catch(async () => {
        await telegram.sendMessage(task.chatId, `Terminal Codex lane failed.\n${userMessage}`);
      });
    state.updateQueueStatus(task.id, "failed", {
      placeholderMessageId: livePlaceholderMessageId,
      errorText: message,
    });
    return true;
  }
}

async function handleTerminalCommand(chatId: string, args: string[]): Promise<void> {
  const action = args[0] ?? "status";
  switch (action) {
    case "status": {
      const terminalStatusText = sanitizeTelegramFinalText(renderTerminalCodexStatus(
        await getTerminalCodexStatus(config, state),
        terminalCodexIdentity(state),
      ));
      await telegram.sendMessage(chatId, [
        terminalStatusText,
        renderActiveTerminalTaskSummary(),
        `Conversation mode: ${terminalChatModeEnabled() ? "on" : "off"}`,
        `Workspace writes in terminal chat: ${terminalConversationAllowsWorkspaceWrites() ? "allowed by profile" : "blocked by profile"}`,
        `Configured backend: ${config.terminal_lane.backend}`,
        `Selected backend: ${selectedTerminalBackend(config, state)}`,
        `Override: ${getTerminalBackendOverride(state) ?? "none"}`,
      ].join("\n"));
      return;
    }
    case "use": {
      const backend = args[1] as TerminalLaneBackend | undefined;
      if (!backend || !["auto", "tmux", "iterm2", "terminal-app"].includes(backend)) {
        await telegram.sendMessage(chatId, "Usage: /terminal use auto|tmux|iterm2|terminal-app");
        return;
      }
      if ((backend === "iterm2" || backend === "terminal-app") && !config.terminal_lane.allow_user_owned_sessions) {
        await telegram.sendMessage(chatId, "User-owned terminal backends are gated. Set terminal_lane.allow_user_owned_sessions = true first.");
        return;
      }
      if (activeTerminalTask) {
        await telegram.sendMessage(chatId, [
          "Terminal Codex lane is busy; refusing to switch backend while a task is active.",
          renderActiveTerminalTaskSummary(),
        ].join("\n"));
        return;
      }
      setTerminalBackendOverride(state, backend);
      setTerminalCodexIdentity(state, null);
      await telegram.sendMessage(chatId, `Terminal backend set to ${backend}. Lock or ping to verify it.`);
      return;
    }
    case "connect":
    case "chat": {
      const subaction = action === "connect" ? "on" : args[1] ?? "status";
      if (["off", "disable", "disabled", "disconnect"].includes(subaction)) {
        setTerminalChatModeEnabled(false);
        await telegram.sendMessage(chatId, "Terminal chat mode disabled. Normal Telegram messages will use the bound desktop bridge path again.");
        return;
      }
      if (["status"].includes(subaction)) {
        await telegram.sendMessage(chatId, [
          `Terminal chat mode: ${terminalChatModeEnabled() ? "on" : "off"}`,
          `Workspace writes: ${terminalConversationAllowsWorkspaceWrites() ? "allowed by terminal profile" : "blocked by terminal profile"}`,
          renderActiveTerminalTaskSummary(),
        ].join("\n"));
        return;
      }
      if (!["on", "enable", "enabled"].includes(subaction)) {
        await telegram.sendMessage(chatId, "Usage: /terminal chat on|off|status");
        return;
      }
      if (activeTerminalTask) {
        await telegram.sendMessage(chatId, [
          "Terminal Codex lane is busy; I will not switch chat targets mid-turn.",
          renderActiveTerminalTaskSummary(),
        ].join("\n"));
        return;
      }
      const identity = await ensureTerminalCodexIdentity(config, state);
      setTerminalChatModeEnabled(true);
      await telegram.sendMessage(chatId, [
        "Terminal chat mode enabled.",
        "Normal Telegram messages will route to the verified terminal Codex lane unless they require native image/audio, live calls, web search, or desktop bridge capabilities.",
        `Backend: ${identity.backend}`,
        `Session: ${identity.name}`,
        `TTY: ${identity.tty ?? "none"}`,
        `Pane: ${identity.paneId ?? "none"}`,
        `Workspace writes: ${terminalConversationAllowsWorkspaceWrites() ? "allowed by terminal profile" : "blocked by terminal profile"}`,
      ].join("\n"));
      return;
    }
    case "disconnect": {
      setTerminalChatModeEnabled(false);
      await telegram.sendMessage(chatId, "Terminal chat mode disabled. Normal Telegram messages will use the bound desktop bridge path again.");
      return;
    }
    case "init":
    case "start": {
      if (activeTerminalTask) {
        await telegram.sendMessage(chatId, [
          "Terminal Codex lane is busy; refusing to start another worker.",
          renderActiveTerminalTaskSummary(),
        ].join("\n"));
        return;
      }
      const identity = await startTerminalCodexWorker(config, state);
      await telegram.sendMessage(chatId, [
        action === "init" ? "Terminal Codex tmux lane initialized." : "Terminal Codex worker started.",
        `Backend: ${identity.backend}`,
        `Session: ${identity.name}`,
        `TTY: ${identity.tty ?? "none"}`,
        `Pane: ${identity.paneId ?? "none"}`,
        `Profile: ${identity.profile ?? config.terminal_lane.profile}`,
        `Sandbox: ${identity.sandbox ?? config.terminal_lane.sandbox}`,
        `Approvals: ${identity.approvalPolicy ?? config.terminal_lane.approval_policy}`,
        `Daemon-owned: ${identity.daemonOwned ? "yes" : "no"}`,
        `Attach: ${terminalAttachCommand(identity.name)}`,
      ].join("\n"));
      return;
    }
    case "stop": {
      if (activeTerminalTask) {
        await telegram.sendMessage(chatId, [
          "Terminal Codex lane is busy; interrupt or wait before stopping it.",
          renderActiveTerminalTaskSummary(),
        ].join("\n"));
        return;
      }
      const stopped = await stopTerminalCodexWorker(config, state);
      await telegram.sendMessage(chatId, stopped
        ? "Stopped the daemon-owned terminal Codex worker."
        : "No daemon-owned terminal worker was stopped. User-owned iTerm2/Terminal sessions are left running.");
      return;
    }
    case "restart": {
      if (activeTerminalTask) {
        await telegram.sendMessage(chatId, [
          "Terminal Codex lane is busy; interrupt or wait before restarting it.",
          renderActiveTerminalTaskSummary(),
        ].join("\n"));
        return;
      }
      await stopTerminalCodexWorker(config, state);
      const identity = await startTerminalCodexWorker(config, state);
      await telegram.sendMessage(chatId, [
        "Terminal Codex worker restarted.",
        `Backend: ${identity.backend}`,
        `Session: ${identity.name}`,
        `TTY: ${identity.tty ?? "none"}`,
        `Pane: ${identity.paneId ?? "none"}`,
        `Profile: ${identity.profile ?? config.terminal_lane.profile}`,
        `Sandbox: ${identity.sandbox ?? config.terminal_lane.sandbox}`,
        `Approvals: ${identity.approvalPolicy ?? config.terminal_lane.approval_policy}`,
        `Attach: ${terminalAttachCommand(identity.name)}`,
      ].join("\n"));
      return;
    }
    case "lock": {
      const identity = await lockTerminalCodexIdentity(config, state);
      await telegram.sendMessage(chatId, [
        "Terminal Codex lane locked.",
        `Backend: ${identity.backend}`,
        `Session: ${identity.name}`,
        `TTY: ${identity.tty ?? "none"}`,
        `Pane: ${identity.paneId ?? "none"}`,
        `Daemon-owned: ${identity.daemonOwned ? "yes" : "no"}`,
      ].join("\n"));
      return;
    }
    case "unlock": {
      if (activeTerminalTask) {
        await telegram.sendMessage(chatId, [
          "Terminal Codex lane is busy; refusing to unlock while a task is active.",
          renderActiveTerminalTaskSummary(),
        ].join("\n"));
        return;
      }
      setTerminalCodexIdentity(state, null);
      await telegram.sendMessage(chatId, "Terminal Codex lane lock cleared. The next terminal task will lock the first verified matching Codex CLI session.");
      return;
    }
    case "ping": {
      if (activeTerminalTask) {
        await telegram.sendMessage(chatId, [
          "Terminal Codex lane is busy.",
          renderActiveTerminalTaskSummary(),
        ].join("\n"));
        return;
      }
      const blocker = terminalWorkCommandBlocker();
      if (blocker) {
        await telegram.sendMessage(chatId, `Terminal Codex ping is blocked right now: ${blocker}.`);
        return;
      }
      await ensureTerminalCodexIdentity(config, state);
      await telegram.sendMessage(chatId, "Pinging the verified terminal Codex lane...");
      const result = await pingTerminalCodex(config, state, { timeoutMs: 90_000, pollIntervalMs: 1_000 });
      await telegram.sendMessage(chatId, [
        result.observed
          ? "Terminal Codex lane replied."
          : "Terminal Codex lane did not produce the expected marker before timeout.",
        `Marker: ${result.marker}`,
        `Backend: ${result.session.backend}`,
        `Session: ${result.session.name}`,
        `TTY: ${result.session.tty ?? "none"}`,
        `Pane: ${result.session.paneId ?? "none"}`,
        `Elapsed: ${Math.round(result.elapsedMs / 1000)}s`,
      ].join("\n"));
      return;
    }
    case "ask": {
      const prompt = args.slice(1).join(" ").trim();
      if (!prompt) {
        await telegram.sendMessage(chatId, "Usage: /terminal ask <prompt>");
        return;
      }
      if (prompt.length > 4_000) {
        await telegram.sendMessage(chatId, "Terminal prompt is too long for this experimental path. Keep it under 4000 characters.");
        return;
      }
      const blocker = terminalWorkCommandBlocker();
      if (blocker) {
        await telegram.sendMessage(chatId, `Terminal Codex ask is blocked right now: ${blocker}.`);
        return;
      }
      if (isTerminalUnsafeRequest(prompt)) {
        await telegram.sendMessage(chatId, "Terminal Codex lane is read-only/artifact-only right now. Send mutation, install, deploy, secret, live-call, image-generation, or desktop-control work to the bound desktop bridge path instead.");
        return;
      }
      await startTerminalAskFromTelegram(chatId, buildTerminalPromptForText(prompt));
      return;
    }
    case "interrupt": {
      await ensureTerminalCodexIdentity(config, state);
      const session = await sendTerminalCodexControl("interrupt", config, state);
      if (activeTerminalTask) {
        clearActiveTerminalTask("terminal interrupt requested");
      }
      await telegram.sendMessage(chatId, [
        "Interrupt sent to terminal Codex lane.",
        `Backend: ${session.backend}`,
        `TTY: ${session.tty ?? "none"}`,
        `Pane: ${session.paneId ?? "none"}`,
      ].join("\n"));
      return;
    }
    case "clear": {
      await ensureTerminalCodexIdentity(config, state);
      if (activeTerminalTask) {
        await telegram.sendMessage(chatId, [
          "Terminal Codex lane is busy; interrupt before clearing.",
          renderActiveTerminalTaskSummary(),
        ].join("\n"));
        return;
      }
      const session = await sendTerminalCodexControl("clear", config, state);
      await telegram.sendMessage(chatId, [
        "Clear command sent to terminal Codex lane.",
        `Backend: ${session.backend}`,
        `TTY: ${session.tty ?? "none"}`,
        `Pane: ${session.paneId ?? "none"}`,
      ].join("\n"));
      return;
    }
    case "reset": {
      await ensureTerminalCodexIdentity(config, state);
      const interrupted = await sendTerminalCodexControl("interrupt", config, state);
      clearActiveTerminalTask("terminal reset requested");
      await telegram.sendMessage(chatId, [
        "Terminal Codex lane reset requested.",
        `Backend: ${interrupted.backend}`,
        `TTY: ${interrupted.tty ?? "none"}`,
        `Pane: ${interrupted.paneId ?? "none"}`,
        "I interrupted the current terminal turn and cleared bridge task state. Run /terminal clear once the prompt is ready if you want to clear Codex context too.",
      ].join("\n"));
      return;
    }
    default:
      await telegram.sendMessage(chatId, "Usage: /terminal [status|connect|disconnect|chat on|chat off|init|start|stop|restart|use auto|tmux|iterm2|terminal-app|lock|unlock|ping|ask <prompt>|interrupt|clear|reset]");
  }
}

async function handleTelegramTerminalIntent(message: TelegramMessage, intent: TelegramTerminalIntent): Promise<boolean> {
  const chatId = String(message.chat.id);
  switch (intent) {
    case "connect": {
      if (activeTerminalTask) {
        await telegram.sendMessage(chatId, [
          "Terminal Codex lane is busy; I will not switch chat targets mid-turn.",
          renderActiveTerminalTaskSummary(),
        ].join("\n"), { replyToMessageId: message.message_id });
        return true;
      }
      const identity = await ensureTerminalCodexIdentity(config, state);
      setTerminalChatModeEnabled(true);
      await telegram.sendMessage(chatId, [
        "Terminal chat mode enabled.",
        "Normal Telegram messages will route to the verified terminal Codex lane unless they require native image/audio, live calls, web search, or desktop bridge capabilities.",
        `Backend: ${identity.backend}`,
        `Session: ${identity.name}`,
        `TTY: ${identity.tty ?? "none"}`,
        `Pane: ${identity.paneId ?? "none"}`,
        `Workspace writes: ${terminalConversationAllowsWorkspaceWrites() ? "allowed by terminal profile" : "blocked by terminal profile"}`,
      ].join("\n"), { replyToMessageId: message.message_id });
      return true;
    }
    case "disconnect":
      setTerminalChatModeEnabled(false);
      await telegram.sendMessage(chatId, "Terminal chat mode disabled. Normal Telegram messages will use the bound desktop bridge path again.", {
        replyToMessageId: message.message_id,
      });
      return true;
    case "ask":
    case "ping":
      return false;
  }
}

async function handleCommand(message: TelegramMessage, text: string): Promise<boolean> {
  const parsed = parseSlashCommand(text);
  if (!parsed) {
    return false;
  }
  const chatId = String(message.chat.id);
  switch (parsed.command) {
    case "/start":
      await telegram.sendMessage(chatId, [
        `${config.branding.product_name} is online.`,
        "Use /help for commands.",
        "Use /capabilities to see what this Telegram-bound session can do right now.",
        "",
        "Voice replies are AI-generated only when you explicitly request them.",
      ].join("\n"));
      return true;
    case "/status":
      await sendStatus(chatId);
      return true;
    case "/where":
      await sendWhere(chatId);
      return true;
    case "/threads":
      await sendThreads(chatId, parsed.args);
      return true;
    case "/inbox":
      await sendInbox(chatId);
      return true;
    case "/help":
      await telegram.sendMessage(chatId, [
        "Commands",
        "/status",
        "/capabilities",
        "/where",
        "/threads [cwd]",
        "/teleport <thread_id|current|back> [cwd]",
        "/inbox",
        "/mode",
        "/mode use <shared-thread-resume|autonomous-thread|shadow-window>",
        "/attach-current [cwd]",
        "/attach <thread_id>",
        "/detach",
        "/owner <telegram|desktop|none>",
        "/sleep",
        "/wake",
        "/interrupt",
        "/reset",
        "/providers",
        "/provider use <asr|tts|image> <provider>",
        "/image <prompt>",
        "/call",
        "/call status",
        "/call enable",
        "/hangup",
        "/fallback [status|enable|disable|reset]",
        "/terminal",
        "/terminal status",
        "/terminal init",
        "/terminal ask <prompt>",
        "/terminal chat on|off",
        "/speak",
        "/shutdown",
        "",
        "Natural-language shortcuts also work: “call me”, “arm call”, “call status”, “connect Telegram to the terminal lane”.",
        "",
        "Voice replies are AI-generated only when you explicitly request them.",
      ].join("\n"));
      return true;
    case "/mode":
      if (parsed.args[0] !== "use") {
        await telegram.sendMessage(chatId, `Current mode: ${codex.getMode()}`);
        return true;
      }
      if (!parsed.args[1]) {
        await telegram.sendMessage(chatId, "Usage: /mode use <shared-thread-resume|autonomous-thread|shadow-window>");
        return true;
      }
      if (!["shared-thread-resume", "autonomous-thread", "shadow-window"].includes(parsed.args[1])) {
        await telegram.sendMessage(chatId, "Unsupported bridge mode.");
        return true;
      }
      await requireIdleControlOperation();
      await codex.setMode(parsed.args[1] as BridgeMode);
      wakeWorker();
      await gatewayClient.sendStatus(gatewayStatusPayload()).catch(() => undefined);
      await telegram.sendMessage(chatId, `Bridge mode set to ${codex.getMode()}.`);
      return true;
    case "/attach-current":
    case "/attach_current": {
      await requireIdleControlOperation();
      const result = await teleportCurrent(parsed.args);
      await telegram.sendMessage(chatId, renderTeleportSuccess({
        binding: result.binding,
        previousBinding: result.previousBinding,
        status: result.status,
      }));
      return true;
    }
    case "/attach": {
      const threadId = parsed.args[0];
      if (!threadId) {
        await telegram.sendMessage(chatId, "Usage: /attach <thread_id>");
        return true;
      }
      await requireIdleControlOperation();
      const result = await teleportThread(threadId);
      await telegram.sendMessage(chatId, renderTeleportSuccess({
        binding: result.binding,
        previousBinding: result.previousBinding,
        status: result.status,
      }));
      return true;
    }
    case "/teleport": {
      const target = parsed.args[0];
      if (!target) {
        await sendThreads(chatId, parsed.args.slice(1));
        return true;
      }
      await requireIdleControlOperation();
      const result = target === "current"
        ? await teleportCurrent(parsed.args.slice(1))
        : target === "back"
          ? await teleportToBinding(requirePreviousTeleportBinding())
          : await teleportThread(target);
      await telegram.sendMessage(chatId, renderTeleportSuccess({
        binding: result.binding,
        previousBinding: result.previousBinding,
        status: result.status,
      }));
      return true;
    }
    case "/detach":
      await requireIdleControlOperation();
      await applyBinding(null);
      wakeWorker();
      await gatewayClient.sendStatus(gatewayStatusPayload()).catch(() => undefined);
      await telegram.sendMessage(chatId, "Cleared the bound desktop thread.");
      return true;
    case "/owner": {
      const owner = parsed.args[0] as BridgeOwner | undefined;
      if (!owner || !["telegram", "desktop", "none"].includes(owner)) {
        await telegram.sendMessage(chatId, "Usage: /owner <telegram|desktop|none>");
        return true;
      }
      await requireIdleControlOperation();
      codex.setOwner(owner);
      codex.setSleeping(owner !== "telegram");
      wakeWorker();
      await gatewayClient.sendStatus(gatewayStatusPayload()).catch(() => undefined);
      await telegram.sendMessage(chatId, `Owner set to ${owner}.`);
      return true;
    }
    case "/sleep":
      await requireIdleControlOperation();
      codex.setOwner("desktop");
      codex.setSleeping(true);
      wakeWorker();
      await gatewayClient.sendStatus(gatewayStatusPayload()).catch(() => undefined);
      await telegram.sendMessage(chatId, "Bridge is sleeping. Desktop now owns the session and new Telegram requests will stay queued.");
      return true;
    case "/wake":
      await requireIdleControlOperation();
      codex.setOwner("telegram");
      codex.setSleeping(false);
      wakeWorker();
      await gatewayClient.sendStatus(gatewayStatusPayload()).catch(() => undefined);
      await telegram.sendMessage(chatId, "Bridge is awake. Telegram now owns the session.");
      return true;
    case "/interrupt":
      await codex.interruptActiveTurn();
      await telegram.sendMessage(chatId, "Interrupt requested.");
      return true;
    case "/reset":
      if (!codex.supportsResetThread()) {
        await telegram.sendMessage(chatId, "Reset is unavailable in this mode. Use /detach or /attach instead.");
        return true;
      }
      await requireIdleControlOperation();
      {
        const threadId = await codex.resetThread();
        wakeWorker();
        await telegram.sendMessage(chatId, `Started a new Codex thread: ${threadId.slice(0, 12)}...`);
      }
      return true;
    case "/providers":
      await sendProviders(chatId);
      return true;
    case "/capabilities":
      await sendCapabilities(chatId);
      return true;
    case "/call":
      if (parsed.args[0] === "status") {
        await sendCallStatus(chatId);
        return true;
      }
      if (parsed.args[0] === "enable" || parsed.args[0] === "on") {
        await handleTelegramCallEnable(chatId, message, "telegram /call enable");
        return true;
      }
      await handleTelegramCallLaunch(chatId, message, "telegram /call");
      return true;
    case "/hangup":
      if (!isCallLive(getActiveCall())) {
        await telegram.sendMessage(chatId, "No live call is active.");
        return true;
      }
      await finalizeCall(getActiveCall()!, "telegram_hangup");
      await telegram.sendMessage(chatId, "Hangup requested.");
      return true;
    case "/terminal":
      await handleTerminalCommand(chatId, parsed.args);
      return true;
    case "/fallback":
      await handleFallbackCommand(chatId, parsed.args);
      return true;
    case "/image": {
      const prompt = parsed.args.join(" ").trim();
      if (!prompt) {
        await telegram.sendMessage(chatId, "Usage: /image <prompt>");
        return true;
      }
      await generateAndSendImage(chatId, prompt, { replyToMessageId: message.message_id });
      return true;
    }
    case "/speak":
      state.setSetting("telegram:speak_next", true);
      await telegram.sendMessage(chatId, "The next text or image request will include an audio reply.");
      return true;
    case "/provider": {
      const [subcommand, modalityArg, providerArg] = parsed.args;
      if (subcommand !== "use" || !modalityArg || !providerArg) {
        await telegram.sendMessage(chatId, "Usage: /provider use <asr|tts|image> <provider>");
        return true;
      }
      const modality = mapProviderAlias(modalityArg);
      const provider = providerArg as ProviderId;
      const validProviders: Record<Modality, ProviderId[]> = {
        asr: ["openai"],
        tts: ["openai", "elevenlabs"],
        image_generation: ["google", "openai"],
      };
      if (!modality || !validProviders[modality].includes(provider)) {
        await telegram.sendMessage(chatId, "Invalid modality or provider.");
        return true;
      }
      state.setProviderOverride(modality, provider);
      await telegram.sendMessage(chatId, `Set ${modality} provider override to ${provider}.`);
      return true;
    }
    case "/shutdown":
      await telegram.sendMessage(chatId, "Shutting down the bridge.");
      await requestShutdown("telegram");
      return true;
    default:
      return false;
  }
}

function sideEffectfulTextUpdateCategory(message: TelegramMessage, text: string): string | null {
  const parsed = parseSlashCommand(text);
  if (parsed) {
    return sideEffectfulSlashCommandCategory(parsed.command, parsed.args);
  }
  if (findPendingUserInputRequest(message)) {
    return "user-input";
  }
  const callIntent = detectTelegramCallIntent(text);
  if (callIntent && callIntent !== "status") {
    return "intent:call";
  }
  const controlIntent = detectTelegramControlIntent(text);
  if (controlIntent) {
    return `intent:${controlIntent}`;
  }
  const terminalIntent = detectTelegramTerminalIntent(text);
  if (terminalIntent === "connect" || terminalIntent === "disconnect") {
    return `intent:terminal:${terminalIntent}`;
  }
  return null;
}

async function handleMessage(update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message) {
    return;
  }
  if (!isAuthorizedMessage(message)) {
    if (message.chat.type === "private") {
      logger.warn("ignored message from unauthorized private chat", {
        chatId: message.chat.id,
        username: message.from?.username ?? null,
        firstName: message.from?.first_name ?? null,
        configuredAuthorizedChatId: config.telegram.authorized_chat_id,
      });
    }
    return;
  }
  if (message.text) {
    const processedUpdateCategory = sideEffectfulTextUpdateCategory(message, message.text);
    let claimedProcessedUpdate = false;
    if (processedUpdateCategory) {
      claimedProcessedUpdate = state.claimProcessedTelegramUpdate(update.update_id, processedUpdateCategory);
      if (!claimedProcessedUpdate) {
        logger.info("duplicate side-effectful Telegram update ignored", {
          updateId: update.update_id,
          category: processedUpdateCategory,
          status: state.getProcessedTelegramUpdate(update.update_id)?.status ?? "unknown",
        });
        return;
      }
    }
    try {
      if (await handleCommand(message, message.text)) {
        if (claimedProcessedUpdate) {
          state.completeProcessedTelegramUpdate(update.update_id);
        }
        return;
      }
      if (await resolvePendingUserInput(message, message.text)) {
        if (claimedProcessedUpdate) {
          state.completeProcessedTelegramUpdate(update.update_id);
        }
        return;
      }
      const callIntent = detectTelegramCallIntent(message.text);
      if (callIntent) {
        await handleTelegramCallIntent(message, callIntent);
        if (claimedProcessedUpdate) {
          state.completeProcessedTelegramUpdate(update.update_id);
        }
        return;
      }
      const controlIntent = detectTelegramControlIntent(message.text);
      if (controlIntent) {
        await handleTelegramControlIntent(message, controlIntent);
        if (claimedProcessedUpdate) {
          state.completeProcessedTelegramUpdate(update.update_id);
        }
        return;
      }
      const terminalIntent = detectTelegramTerminalIntent(message.text);
      if (terminalIntent && await handleTelegramTerminalIntent(message, terminalIntent)) {
        if (claimedProcessedUpdate) {
          state.completeProcessedTelegramUpdate(update.update_id);
        }
        return;
      }
    } catch (error) {
      if (claimedProcessedUpdate) {
        state.failProcessedTelegramUpdate(update.update_id, error);
      }
      const messageText = error instanceof Error ? error.message : String(error);
      const userMessage = sanitizeTelegramErrorText(messageText);
      logger.warn("telegram command failed", {
        chatId: message.chat.id,
        text: message.text,
        error: messageText,
      });
      await telegram.sendMessage(String(message.chat.id), `Command failed.\n${userMessage}`, {
        replyToMessageId: message.message_id,
      });
      return;
    }
  }
  const task = buildTelegramTask(update.update_id, message, nextSpeakFlag, nextFastAsrFlag);
  if (!task) {
    return;
  }
  maybeCarryForwardConversationalPreferences(task);
  if (isCallLive(getActiveCall())) {
    const callId = getActiveCall()!.callId;
    try {
      const item = await trackCallInboxStage(callId, stageCallInboxItem(task));
      const note = item.kind === "image"
        ? "Captured the image for the active live call. It will be referenced in the handoff."
        : item.kind === "document"
          ? "Captured the file for the active live call. It will be referenced in the handoff."
          : item.kind === "video"
            ? "Captured the video for the active live call. It will be referenced in the handoff."
          : item.kind === "voice" || item.kind === "audio"
            ? "Captured the audio for the active live call and staged a transcript for the handoff."
            : "Captured the message for the active live call. It will be included in the handoff.";
      await telegram.sendMessage(task.chatId, note, { replyToMessageId: task.messageId });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      const userMessage = sanitizeTelegramErrorText(messageText);
      logger.warn("failed to capture in-call Telegram item", {
        taskId: task.id,
        error: messageText,
      });
      const note = error instanceof ClosedCallMutationError
        ? "The live call was already ending, so this item was not added to the call handoff. Send it again and I will treat it as a normal Telegram follow-up."
        : `Failed to capture this in-call item.\n${userMessage}`;
      await telegram.sendMessage(task.chatId, note);
    }
    return;
  }
  try {
    state.enqueueTask(task);
  } catch (error) {
    logger.warn("duplicate update ignored", { updateId: update.update_id, error: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (task.kind === "image") {
    const staging = stageImageTask(task)
      .catch((error: unknown) => {
        logger.warn("failed to stage image while queued", {
          taskId: task.id,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        imageStaging.delete(task.id);
      });
    imageStaging.set(task.id, staging);
  }
  wakeWorker();
  const holdReason = await effectiveQueueHoldReason();
  const pendingCount = state.getQueuedTaskCount();
  const aheadCount = Math.max(0, pendingCount - 1) + (activeTask ? 1 : 0);
  const bypassesHoldToTerminal = taskCanBypassHoldToTerminal(task, holdReason);
  if ((aheadCount > 0 || holdReason) && !bypassesHoldToTerminal) {
    const placeholder = await telegram.sendMessage(
      task.chatId,
      buildQueuedPlaceholder(task, aheadCount, holdReason),
    );
    state.updateQueueStatus(task.id, "pending", { placeholderMessageId: placeholder.message_id });
  }
  if ((aheadCount > 0 || holdReason) && !bypassesHoldToTerminal) {
    await maybeNotifyQueuedTask(task, aheadCount, holdReason).catch((error: unknown) => {
      logger.warn("failed to show desktop notification", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } else if (task.kind === "image") {
    await maybeNotifyQueuedTask(task, 0, null).catch((error: unknown) => {
      logger.warn("failed to show desktop notification", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

async function handleUpdate(update: TelegramUpdate): Promise<void> {
  if (update.callback_query) {
    if (isAuthorizedMessage(update.callback_query.message)) {
      if (!state.claimProcessedTelegramUpdate(update.update_id, "callback:approval")) {
        logger.info("duplicate Telegram callback update ignored", {
          updateId: update.update_id,
          status: state.getProcessedTelegramUpdate(update.update_id)?.status ?? "unknown",
        });
        return;
      }
      try {
        await resolveApproval(update.callback_query);
        state.completeProcessedTelegramUpdate(update.update_id);
      } catch (error) {
        state.failProcessedTelegramUpdate(update.update_id, error);
        throw error;
      }
    }
    return;
  }
  if (update.message) {
    await handleMessage(update);
  }
}

async function pollLoop(): Promise<void> {
  let offset = state.getSetting<number>("telegram:last_update_id", 0) + 1;
  while (!shutdownRequested) {
    try {
      pollAbortController = new AbortController();
      const updates = await telegram.getUpdates(
        offset,
        config.telegram.poll_timeout_seconds,
        config.telegram.long_poll_limit,
        pollAbortController.signal,
      );
      for (const update of updates) {
        await handleUpdate(update);
        offset = Math.max(offset, update.update_id + 1);
        state.setSetting("telegram:last_update_id", update.update_id);
      }
    } catch (error) {
      if (shutdownRequested) {
        break;
      }
      logger.error("polling failed", { error: error instanceof Error ? error.message : String(error) });
      await sleep(1000);
    } finally {
      pollAbortController = null;
    }
  }
}

function registerCodexEventHandlers(backend: BridgeBackendManager, lane: BridgeLane): void {
  backend.on("serverRequest", (request: JsonRpcRequest) => {
    handleServerRequest(request as { id: string | number; method: string; params?: any }, backend, lane).catch((error: unknown) => {
      logger.error("failed to handle server request", {
        lane,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  backend.on("turnStarted", (event: { turnId: string | null; threadId: string | null }) => {
    const current = state.getActiveTask();
    if (current && (current.lane ?? "primary") !== lane) {
      return;
    }
    state.markActiveTaskSubmitted({
      turnId: event.turnId,
      threadId: event.threadId,
    });
    void syncActiveTaskSubmittedPlaceholder(backend.getMode()).catch((error: unknown) => {
      logger.warn("failed to update submitted placeholder", {
        lane,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  backend.on("turnFinalText", (event: { text: string }) => {
    if (!activeTask || (activeTask.task.lane ?? "primary") !== lane) {
      return;
    }
    enqueuePreviewText(activeTask.task.id, activeTask.task.chatId, event.text);
  });
}

async function main(): Promise<void> {
  ensureDir(config.storageRoot);
  await preparePersistentLog(join(config.storageRoot, "telegram-daemon.log"), "telegram-daemon");
  await mkdir(inboundRoot, { recursive: true });
  await mkdir(normalizedRoot, { recursive: true });
  await mkdir(outboundRoot, { recursive: true });
  const callsRoot = ensureDir(join(config.storageRoot, "calls"));
  await recoverCallSurfaceOnStartup();
  const timeoutCallCutoffMs = Date.now() - (60 * 60 * 1000);
  const activeCallId = state.getActiveCall()?.callId;
  const removedEmptyTimeoutCalls = await cleanupEmptyTimeoutCallArtifacts(callsRoot, timeoutCallCutoffMs, {
    preserveCallIds: activeCallId ? [activeCallId] : [],
  });
  if (removedEmptyTimeoutCalls.removedDirs > 0) {
    logger.info("removed stale empty timeout call artifacts", {
      removedDirs: removedEmptyTimeoutCalls.removedDirs,
      freedBytes: removedEmptyTimeoutCalls.freedBytes,
    });
  }

  if (config.storage.retention_days > 0) {
    const cutoffMs = Date.now() - (config.storage.retention_days * 24 * 60 * 60 * 1000);
    const keepPaths = state.getRetentionProtectedPaths();
    const cleanup = await cleanupStorageRoots(
      [
        join(config.storageRoot, "artifacts"),
        inboundRoot,
        join(config.storageRoot, "log-archive"),
        normalizedRoot,
        outboundRoot,
        callsRoot,
      ],
      cutoffMs,
      { keepPaths },
    );
    if (cleanup.removedFiles > 0 || cleanup.removedDirs > 0) {
      logger.info("removed stale bridge storage", {
        retentionDays: config.storage.retention_days,
        removedFiles: cleanup.removedFiles,
        removedDirs: cleanup.removedDirs,
        freedBytes: cleanup.freedBytes,
      });
    }
  }
  const prunedArtifactRows = state.pruneMissingArtifactRecords();
  if (prunedArtifactRows > 0) {
    logger.info("pruned stale artifact rows", { removedRows: prunedArtifactRows });
  }

  const existingPid = await readPidFile(pidFilePath);
  if (existingPid && existingPid !== process.pid && isProcessRunning(existingPid)) {
    throw new Error(`telegram-daemon is already running with pid ${existingPid}`);
  }
  if (!existingPid || !isProcessRunning(existingPid)) {
    const discoveredDaemon = await findRunningProcessByPattern(TELEGRAM_DAEMON_PROCESS_PATTERN, {
      excludePid: process.pid,
      cwd: config.repoRoot,
    }).catch(() => null);
    if (discoveredDaemon) {
      throw new Error(`telegram-daemon is already running with pid ${discoveredDaemon.pid}`);
    }
  }
  if (!existingPid || !isProcessRunning(existingPid)) {
    const cleaned = await cleanupStaleCodexAppServer(config.codex.app_server_port, {
      cwd: config.repoRoot,
    }).catch(error => {
      logger.warn("failed to clean stale app-server before startup", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    });
    if (cleaned) {
      logger.warn("cleaned stale app-server before daemon startup", {
        pid: cleaned.pid,
        command: cleaned.command,
        port: config.codex.app_server_port,
      });
    }
  }

  await writePidFile(pidFilePath, process.pid);
  process.on("SIGINT", () => { void requestShutdown("SIGINT"); });
  process.on("SIGTERM", () => { void requestShutdown("SIGTERM"); });
  process.on("uncaughtException", error => {
    logger.error("uncaught exception", { error: error instanceof Error ? error.message : String(error) });
    void requestShutdown("uncaughtException");
  });
  process.on("unhandledRejection", reason => {
    logger.error("unhandled rejection", { error: reason instanceof Error ? reason.message : String(reason) });
    void requestShutdown("unhandledRejection");
  });

  await runTelegramPreflight();
  registerCodexEventHandlers(codex, "primary");
  registerCodexEventHandlers(fallbackCodex, "fallback");
  await reconcileInterruptedWork(recoveredActiveTask);
  await codex.start();
  codex.onBackendUnavailable(event => {
    logger.error("codex backend became unavailable", {
      reason: event.reason,
      detail: event.detail,
    });
    void recoverBackendAfterUnavailable(event).then(recovered => {
      if (!recovered) {
        logger.error("codex backend could not be recovered", {
          reason: event.reason,
          detail: event.detail,
        });
        return requestShutdown(`codex_backend_${event.reason}`);
      }
      return undefined;
    });
  });
  fallbackCodex.onBackendUnavailable(event => {
    logger.warn("fallback codex backend became unavailable", {
      reason: event.reason,
      detail: event.detail,
    });
    void fallbackCodex.sync(true).catch((error: unknown) => {
      logger.warn("fallback codex backend recovery failed", {
        reason: event.reason,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  persistGatewayBridgeConnection(gatewayClient.isConnected());
  gatewayClient.onConnectionStateChange(connected => {
    persistGatewayBridgeConnection(connected);
    if (!connected) {
      void reconcileCallSurfaceLifecycle("gateway_disconnect").catch(error => {
        logger.warn("failed to reconcile call surface after gateway disconnect", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  });
  gatewayClient.onPrepareCall(prepareGatewayCall);
  gatewayClient.onCallEvent(async payload => {
    await handleGatewayCallEvent(payload);
  });
  gatewayClient.onHangupRequest(async payload => {
    const call = getActiveCall();
    if (call && call.callId === payload.callId) {
      await finalizeCall(call, payload.reason, { notifyGateway: false });
    }
  });
  try {
    await gatewayClient.start(gatewayStatusPayload());
    persistGatewayBridgeConnection(gatewayClient.isConnected());
  } catch (error) {
    persistGatewayBridgeConnection(false);
    logger.warn("realtime gateway unavailable at startup; continuing without live call control until reconnect succeeds", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  await recoverInterruptedCall();
  await maybeSendGeneratedImages(config.telegram.authorized_chat_id, { labelOlderAsRecovered: true }).catch(error => {
    logger.warn("failed to deliver recovered generated images", { error: error instanceof Error ? error.message : String(error) });
  });
  await maybeSendGeneratedDocuments(config.telegram.authorized_chat_id, { labelOlderAsRecovered: true }).catch(error => {
    logger.warn("failed to deliver recovered generated documents", { error: error instanceof Error ? error.message : String(error) });
  });
  await maybeSendGeneratedVideos(config.telegram.authorized_chat_id, { labelOlderAsRecovered: true }).catch(error => {
    logger.warn("failed to deliver recovered generated videos", { error: error instanceof Error ? error.message : String(error) });
  });
  await maybeSendGeneratedAudio(config.telegram.authorized_chat_id, { labelOlderAsRecovered: true }).catch(error => {
    logger.warn("failed to deliver recovered generated audio", { error: error instanceof Error ? error.message : String(error) });
  });
  callSurfaceSweepTimer = setInterval(() => {
    void reconcileCallSurfaceLifecycle("interval").catch(error => {
      logger.warn("failed to reconcile call surface lifecycle", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, 15_000);
  callSurfaceSweepTimer.unref?.();
  recoverPersistedTerminalTask();
  void ensureWorker();
  await pollLoop();
  const activeCall = getActiveCall();
  if (activeCall && callNeedsFinalization(activeCall)) {
    await finalizeCall(activeCall, activeCall.endedReason ?? "bridge_shutdown", {
      notifyGateway: isCallLive(activeCall),
      ...(activeCall.endedAt ? { endedAt: activeCall.endedAt } : {}),
    }).catch(error => {
      logger.warn("failed to finalize call during shutdown", {
        callId: activeCall.callId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

main().catch(error => {
  logger.error("fatal startup failure", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}).finally(async () => {
  shutdownRequested = true;
  if (callSurfaceSweepTimer) {
    clearInterval(callSurfaceSweepTimer);
    callSurfaceSweepTimer = null;
  }
  persistGatewayBridgeConnection(false);
  await disarmCallSurfaceLifecycle("daemon_finally").catch(() => undefined);
  await gatewayClient.close().catch((error: unknown) => {
    logger.warn("failed to close realtime gateway client", { error: error instanceof Error ? error.message : String(error) });
  });
  await codex.close().catch((error: unknown) => {
    logger.warn("failed to close codex backend manager", { error: error instanceof Error ? error.message : String(error) });
  });
  await fallbackCodex.close().catch((error: unknown) => {
    logger.warn("failed to close fallback codex backend manager", { error: error instanceof Error ? error.message : String(error) });
  });
  await removePidFile(pidFilePath, process.pid).catch(error => {
    logger.warn("failed to remove pid file", { error: error instanceof Error ? error.message : String(error) });
  });
});
