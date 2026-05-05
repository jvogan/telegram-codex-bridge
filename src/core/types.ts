export const PROVIDERS_BY_MODALITY = {
  asr: ["openai"],
  tts: ["openai", "elevenlabs"],
  image_generation: ["openai", "google"],
} as const;

export type ProviderId = "openai" | "elevenlabs" | "google";
export type ArtifactProviderId = ProviderId | "bridge";
export type Modality = "asr" | "tts" | "image_generation";
export const BRIDGE_MODES = ["autonomous-thread", "shared-thread-resume", "shadow-window"] as const;
export const SHADOW_WINDOW_NOTICE = "shadow-window is experimental, macOS-only, and non-core.";
export type BridgeMode = (typeof BRIDGE_MODES)[number];
export type BridgeLane = "primary" | "fallback";
export type FallbackLaneRouting = "when_desktop_busy_safe";
export type TerminalLaneBackend = "auto" | "tmux" | "iterm2" | "terminal-app";
export type TerminalLaneResolvedBackend = Exclude<TerminalLaneBackend, "auto">;
export type TerminalLaneProfile = "public-safe" | "power-user";
export type TerminalLaneSandbox = "read-only" | "workspace-write";
export type TerminalLaneApprovalPolicy = "never" | "on-request";
export type TerminalLaneReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type BridgeOwner = "telegram" | "desktop" | "none";
export type RealtimeSurfaceMode = "manual-arm";
export type RealtimeTunnelMode = "managed-quick-cloudflared" | "static-public-url";
export type CallStatus = "starting" | "active" | "finalizing" | "ended" | "interrupted";
export type CallInboxStatus = "queued" | "staged" | "included";

export type QueueStatus = "pending" | "processing" | "completed" | "failed" | "cancelled";
export type ApprovalStatus = "pending" | "resolved" | "expired";
export type ActiveTaskStage = "preparing" | "requesting" | "submitted";

export interface ProviderStatus {
  id: ProviderId;
  modality: Modality;
  available: boolean;
  reachable: boolean;
  detail: string;
}

export interface StoredArtifact {
  id: string;
  modality: "audio" | "image" | "transcript" | "document" | "video";
  providerId: ArtifactProviderId;
  source: "mcp" | "telegram" | "automatic";
  path: string;
  mimeType: string;
  fileName: string;
  createdAt: number;
  metadata: Record<string, unknown>;
  deliveredAt: number | null;
}

export interface TranscriptionResult {
  providerId: ProviderId;
  text: string;
  raw?: Record<string, unknown>;
}

export interface SpeechResult {
  providerId: ProviderId;
  buffer: Buffer;
  mimeType: string;
  fileExtension: string;
  raw?: Record<string, unknown>;
}

export interface ImageGenerationResult {
  providerId: ProviderId;
  buffer: Buffer;
  mimeType: string;
  fileExtension: string;
  revisedPrompt?: string | null;
  raw?: Record<string, unknown>;
}

export interface ProviderSelection {
  providerId?: ProviderId;
  model?: string;
  voice?: string;
}

export interface TranscriptionInput extends ProviderSelection {
  filePath: string;
  prompt?: string;
  language?: string;
}

export interface SpeechInput extends ProviderSelection {
  text: string;
  instructions?: string;
  responseFormat?: string;
}

export interface ImageGenerationInput extends ProviderSelection {
  prompt: string;
  size?: string;
  aspectRatio?: string;
}

export interface QueuedTelegramTask {
  id: string;
  lane?: BridgeLane;
  updateId: number;
  chatId: string;
  messageId: number;
  kind: "text" | "image" | "voice" | "audio" | "document" | "video";
  text: string;
  photoFileId?: string;
  stagedImagePath?: string;
  imageFileName?: string;
  imageMimeType?: string;
  imageFileSize?: number;
  videoFileId?: string;
  videoFileName?: string;
  videoMimeType?: string;
  videoFileSize?: number;
  videoDurationSeconds?: number;
  videoPath?: string;
  videoTranscriptText?: string;
  mediaFileId?: string;
  mediaFileName?: string;
  mediaMimeType?: string;
  mediaFileSize?: number;
  mediaDurationSeconds?: number;
  originalMediaPath?: string;
  normalizedMediaPath?: string;
  documentFileId?: string;
  documentFileName?: string;
  documentMimeType?: string;
  documentFileSize?: number;
  documentPath?: string;
  mediaPreviewPath?: string;
  transcriptText?: string;
  transcriptArtifactId?: string;
  transcriptArtifactPath?: string;
  forceSpeak?: boolean;
  preferFastAsr?: boolean;
  createdAt: number;
}

export interface CallInboxItem extends QueuedTelegramTask {
  callId: string;
  status: CallInboxStatus;
  mediaPath?: string;
  transcriptText?: string;
  transcriptArtifactId?: string;
  transcriptPath?: string;
}

export interface BoundThread {
  threadId: string;
  cwd: string;
  rolloutPath: string;
  source: string;
  title?: string;
  updatedAt?: number;
  boundAt: number;
}

export interface BackendStatus {
  mode: BridgeMode;
  threadId: string | null;
  cwd: string | null;
  binding: BoundThread | null;
  supportsReset: boolean;
  supportsApprovals: boolean;
}

export interface TelegramMessageRef {
  chatId: string;
  messageId: number;
}

export interface ApprovalRecord {
  localId: string;
  requestId: string;
  method: string;
  payloadJson: string;
  promptMessageId: number;
  createdAt: number;
  status: ApprovalStatus;
}

export interface ActiveTaskRecord {
  queueId: string;
  lane?: BridgeLane;
  chatId: string;
  placeholderMessageId: number | null;
  startedAt: number;
  mode: BridgeMode;
  stage: ActiveTaskStage;
  threadId: string | null;
  boundThreadId: string | null;
  rolloutPath: string | null;
  turnId: string | null;
}

export interface RecentFailedTaskRecord {
  task: QueuedTelegramTask;
  errorText: string | null;
  updatedAt: number;
}

export interface RecentCallSummary {
  callId: string;
  endedAt: number;
  endedReason: string;
  transcriptPath: string;
  handoffJsonPath: string;
  handoffMarkdownPath: string;
  bundlePath: string;
  hasUsableContent: boolean;
  handoffQueued: boolean;
  artifactAppendedAt: number | null;
  recapMessageId: number | null;
}

export interface GatewayBridgeConnectionState {
  connected: boolean;
  updatedAt: number;
}

export type RealtimeCallSurfaceEventAction = "arm" | "start" | "invite" | "disarm";
export type RealtimeCallSurfaceEventOutcome = "ok" | "blocked" | "error";

export interface RealtimeCallSurfaceEvent {
  at: number;
  action: RealtimeCallSurfaceEventAction;
  outcome: RealtimeCallSurfaceEventOutcome;
  source: string;
  detail: string;
}

export interface RealtimeCallSurfaceRecord {
  armed: boolean;
  armedAt: number | null;
  armedBy: string | null;
  expiresAt: number | null;
  lastActivityAt: number | null;
  lastPublicProbeAt: number | null;
  lastPublicProbeReady: boolean | null;
  lastPublicProbeDetail: string | null;
  lastPublicUrl: string | null;
  lastHealthUrl: string | null;
  lastLaunchUrl: string | null;
  lastDisarmReason: string | null;
  launchTokenId: string | null;
  launchTokenBridgeId: string | null;
  launchTokenTelegramUserId: string | null;
  launchTokenTelegramChatInstance: string | null;
  launchTokenReservedAt: number | null;
  launchTokenExpiresAt: number | null;
  tunnelMode: RealtimeTunnelMode;
  tunnelPid: number | null;
  tunnelUrl: string | null;
  tunnelStartedAt: number | null;
  recentEvents?: RealtimeCallSurfaceEvent[] | null;
}

export interface ShutdownHintRecord {
  source: string;
  initiatedBy: string;
  requestedAt: number;
  details?: Record<string, unknown>;
}

export interface CallContextMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: string | null;
  source: "thread" | "telegram";
}

export interface CallContextPack {
  callId: string;
  boundThreadId: string | null;
  cwd: string | null;
  mode: BridgeMode;
  owner: BridgeOwner;
  sessionSummary: string;
  recentTurns: CallContextMessage[];
  goals: string[];
  openTasks: string[];
  queuedItems: string[];
  operatorNotes: string[];
  generatedAt: number;
}

export interface CallLedger {
  decisions: string[];
  actionItems: string[];
  openQuestions: string[];
  importantFacts: string[];
  attachments: Array<{
    id: string;
    kind: "text" | "image" | "voice" | "audio" | "document" | "video";
    text: string;
    path?: string;
    transcriptPath?: string;
  }>;
}

export interface ActiveCallRecord {
  callId: string;
  bridgeId: string;
  status: CallStatus;
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
  endedReason: string | null;
  boundThreadId: string | null;
  cwd: string | null;
  gatewayCallId: string | null;
  telegramUserId: string | null;
  telegramChatInstance: string | null;
  contextPack: CallContextPack | null;
  eventPath: string;
  transcriptPath: string;
  statePath: string;
  handoffJsonPath: string;
  handoffMarkdownPath: string;
  artifactAppendedAt: number | null;
  recapMessageId: number | null;
}

export interface CallArtifact {
  callId: string;
  boundThreadId: string | null;
  cwd: string | null;
  startedAt: number;
  endedAt: number;
  endedReason: string;
  summary: string;
  decisions: string[];
  actionItems: string[];
  openQuestions: string[];
  importantFacts: string[];
  attachments: Array<{
    id: string;
    kind: "text" | "image" | "voice" | "audio" | "document" | "video";
    text: string;
    path?: string;
    transcriptPath?: string;
  }>;
  transcriptPath: string;
}

export interface PendingCallHandoffRecord {
  callId: string;
  artifact: CallArtifact;
  chatId: string;
  createdAt: number;
  updatedAt: number;
  attemptCount: number;
  lastError: string | null;
}

export interface MediaDefaults {
  asr: ProviderId;
  tts: ProviderId;
  image_generation: ProviderId;
}

export interface ProviderFallbacks {
  asr: ProviderId[];
  tts: ProviderId[];
  image_generation: ProviderId[];
}
