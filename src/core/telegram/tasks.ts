import { existsSync } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { promisify } from "node:util";

import type { ArtifactStore } from "../artifacts.js";
import type { CodexTurnInput } from "../codex/session.js";
import type { MediaRegistry } from "../media/registry.js";
import type { QueuedTelegramTask } from "../types.js";
import { extractVideoFrame, transcodeToWav } from "../util/ffmpeg.js";
import { looksLikeBoundSessionRequest } from "./bound-session-intent.js";
import type { TelegramClient } from "./client.js";
import { telegramProgressText } from "./progress-text.js";
import type { TelegramMessage } from "./types.js";

const TEXT_DOCUMENT_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".csv", ".diff", ".env", ".go", ".h", ".hpp", ".html", ".java",
  ".js", ".json", ".jsonl", ".kt", ".log", ".md", ".markdown", ".mjs", ".py", ".rb", ".rs", ".sh", ".sql",
  ".svg", ".swift", ".toml", ".ts", ".tsx", ".txt", ".tsv", ".xml", ".yaml", ".yml", ".zsh",
]);

const INLINE_DOCUMENT_BYTE_LIMIT = 64 * 1024;
const INLINE_DOCUMENT_CHAR_LIMIT = 32_000;
export const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
export const MAX_DOCUMENT_INPUT_BYTES = 15 * 1024 * 1024;
export const MAX_AUDIO_INPUT_BYTES = 20 * 1024 * 1024;
export const MAX_AUDIO_INPUT_DURATION_SECONDS = 10 * 60;
export const MAX_VIDEO_INPUT_BYTES = 40 * 1024 * 1024;
export const MAX_VIDEO_INPUT_DURATION_SECONDS = 10 * 60;
export const TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 60_000;
export const DOCUMENT_EXTRACTION_TIMEOUT_MS = 20_000;
export const MEDIA_PREPARATION_TIMEOUT_MS = 60_000;
const execFile = promisify(execFileCallback);
const AUDIO_REPLY_PATTERNS = [
  /\b(reply|respond|answer|send(?:\s+it)?(?:\s+back)?|return|give me)\b[\s\S]{0,48}\b(audio|voice(?:\s+note|\s+reply|\s+message)?|spoken|tts)\b/i,
  /\b(audio|voice(?:\s+note|\s+reply|\s+message)?|spoken|tts)\b[\s\S]{0,48}\b(reply|response|answer|version)\b/i,
  /\b(read|say|speak)\b[\s\S]{0,48}\b(aloud|out loud|as audio|as a voice note|as voice|in audio|in voice)\b/i,
  /\b(generate|make|create|produce|record)\b[\s\S]{0,64}\b(audio|voice(?:\s+note|\s+reply|\s+message)?|spoken|tts|narration)\b/i,
  /\b(audio|voice(?:\s+note|\s+reply|\s+message)?|spoken|tts|narration)\b[\s\S]{0,64}\b(overview|summary|walkthrough|briefing|explanation|version)\b/i,
];
const FAST_ASR_PATTERNS = [
  /\b(fast|faster|quick|quickly|sped[\s-]*up|speed[\s-]*up)\b[\s\S]{0,48}\b(asr|stt|speech[\s-]*to[\s-]*text|transcrib(?:e|ed|ing|er|tion)|transcript)\b/i,
  /\b(asr|stt|speech[\s-]*to[\s-]*text|transcrib(?:e|ed|ing|er|tion)|transcript)\b[\s\S]{0,48}\b(fast|faster|quick|quickly|sped[\s-]*up|speed[\s-]*up)\b/i,
  /\b(?:let['’]?s|please|can you|could you|use|do|try|switch to|enable|turn on)\b[\s\S]{0,24}\b(fast|faster|quick|quickly|sped[\s-]*up|speed[\s-]*up)\s+mode\b[\s\S]{0,40}\b(audio|voice|recording|note|demo|asr|stt|speech[\s-]*to[\s-]*text|transcrib(?:e|ed|ing|er|tion)|transcript)\b/i,
  /\b(audio|voice|recording|note|demo|asr|stt|speech[\s-]*to[\s-]*text|transcrib(?:e|ed|ing|er|tion)|transcript)\b[\s\S]{0,40}\b(fast|faster|quick|quickly|sped[\s-]*up|speed[\s-]*up)\s+mode\b/i,
];
const FAST_ASR_RELAXED_PATTERNS = [
  /\b(?:as fast as possible|keep(?:\s+it)? fast|fast(?:er)?\s+mode|quick\s+mode)\b[\s\S]{0,48}\b(audio|voice(?:\s+note|\s+message|\s+reply)?|recording|demo(?:\s+mode)?|speech)\b/i,
  /\b(audio|voice(?:\s+note|\s+message|\s+reply)?|recording|demo(?:\s+mode)?|speech)\b[\s\S]{0,48}\b(?:as fast as possible|keep(?:\s+it)? fast|fast(?:er)?\s+mode|quick\s+mode)\b/i,
  /\b(?:demo(?:\s+mode)?|audio|voice(?:\s+note|\s+message|\s+reply)?|recording)\b[\s\S]{0,64}\b(fast|faster|quick|quickly|sped[\s-]*up|speed[\s-]*up)\b/i,
];
const IMAGE_GENERATION_PATTERNS = [
  /\b(generat(?:e|es|ed|ing)|mak(?:e|es|ing)|creat(?:e|es|ed|ing)|draw(?:s|ing)?|design(?:s|ed|ing)?|render(?:s|ed|ing)?|illustrat(?:e|es|ed|ing)|paint(?:s|ed|ing)?|produc(?:e|es|ed|ing))\b[\s\S]{0,100}\b(image|picture|photo|illustration|graphic|poster|cover|logo|icon|wallpaper|avatar|profile\s+(?:pic|picture|photo)|mascot|thumbnail|banner|hero|header|card|meme|sticker|emoji|sprite|concept\s+art|character|creature|environment|landscape|portrait|infographic|diagram|chart|mockup|ui|interface|layout)\b/i,
  /\b(image|picture|photo|illustration|graphic|poster|cover|logo|icon|wallpaper|avatar|profile\s+(?:pic|picture|photo)|mascot|thumbnail|banner|hero|header|card|meme|sticker|emoji|sprite|concept\s+art|character|creature|environment|landscape|portrait|infographic|diagram|chart|mockup|ui|interface|layout)\b[\s\S]{0,100}\b(generat(?:e|es|ed|ing|ion)|gen|mak(?:e|es|ing)|creat(?:e|es|ed|ing|ion)|draw(?:s|ing)?|design(?:s|ed|ing)?|render(?:s|ed|ing)?|illustrat(?:e|es|ed|ing)|paint(?:s|ed|ing)?|produc(?:e|es|ed|ing))\b/i,
  /\b(generat(?:e|es|ed|ing)|mak(?:e|es|ing)|creat(?:e|es|ed|ing)|draw(?:s|ing)?|design(?:s|ed|ing)?|render(?:s|ed|ing)?|illustrat(?:e|es|ed|ing)|paint(?:s|ed|ing)?|produc(?:e|es|ed|ing))\b[\s\S]{0,120}\b(manga|anime|comic|cartoon|panel|storyboard|scene|frame|splash\s+page|comic\s+strip|webtoon|pixel\s+art|watercolor|oil\s+painting|sketch|line\s+art|3d|claymation|cinematic|photorealistic|cyberpunk|solarpunk|steampunk|fantasy|sci[-\s]?fi)\b/i,
  /\b(manga|anime|comic|cartoon|panel|storyboard|scene|frame|splash\s+page|comic\s+strip|webtoon|pixel\s+art|watercolor|oil\s+painting|sketch|line\s+art|3d|claymation|cinematic|photorealistic|cyberpunk|solarpunk|steampunk|fantasy|sci[-\s]?fi)\b[\s\S]{0,120}\b(generat(?:e|es|ed|ing|ion)|gen|mak(?:e|es|ing)|creat(?:e|es|ed|ing|ion)|draw(?:s|ing)?|design(?:s|ed|ing)?|render(?:s|ed|ing)?|illustrat(?:e|es|ed|ing)|paint(?:s|ed|ing)?|produc(?:e|es|ed|ing))\b/i,
  /\b(generat(?:e|es|ed|ing)|mak(?:e|es|ing)|creat(?:e|es|ed|ing)|draw(?:s|ing)?|design(?:s|ed|ing)?|render(?:s|ed|ing)?|illustrat(?:e|es|ed|ing))\b[\s\S]{0,120}\b(?:highly\s+detailed|detailed|labeled|labelled|annotated)\b[\s\S]{0,80}\b(?:model|schematic|visuali[sz]ation|cutaway)\b[\s\S]{0,80}\b(?:protein|enzyme|receptor|antibody|cell|cellular|molecular|molecule|dna|rna|holoenzyme|telomerase|virus|bacteria|biological|scientific)\b/i,
  /\b(generat(?:e|es|ed|ing)|mak(?:e|es|ing)|creat(?:e|es|ed|ing)|draw(?:s|ing)?|design(?:s|ed|ing)?|render(?:s|ed|ing)?|illustrat(?:e|es|ed|ing))\b[\s\S]{0,120}\b(?:3d|three[-\s]?dimensional|molecular|structural|scientific|biological|cellular|annotated|labeled|labelled|detailed|highly\s+detailed)?\s*model\s+(?:of|for)\s+(?:a\s+|an\s+|the\s+|human\s+)?(?:protein|enzyme|receptor|antibody|cell|molecule|dna|rna|holoenzyme|telomerase|virus|bacteria)\b/i,
  /\b(generat(?:e|es|ed|ing)|mak(?:e|es|ing)|creat(?:e|es|ed|ing)|draw(?:s|ing)?|design(?:s|ed|ing)?|render(?:s|ed|ing)?|illustrat(?:e|es|ed|ing))\b[\s\S]{0,120}\b(?:protein|enzyme|receptor|antibody|cell|cellular|molecular|molecule|dna|rna|holoenzyme|telomerase|virus|bacteria|biological|scientific)\b[\s\S]{0,80}\b(?:model|schematic|visuali[sz]ation|cutaway)\b/i,
  /\b(generat(?:e|es|ed|ing)|mak(?:e|es|ing)|creat(?:e|es|ed|ing)|draw(?:s|ing)?|design(?:s|ed|ing)?|render(?:s|ed|ing)?|illustrat(?:e|es|ed|ing)|paint(?:s|ed|ing)?|produc(?:e|es|ed|ing))\b[\s\S]{0,80}\b(?:graphical|visual)\s+abstract\b/i,
  /\b(?:graphical|visual)\s+abstract\b[\s\S]{0,80}\b(generat(?:e|es|ed|ing|ion)|gen|mak(?:e|es|ing)|creat(?:e|es|ed|ing|ion)|draw(?:s|ing)?|design(?:s|ed|ing)?|render(?:s|ed|ing)?|illustrat(?:e|es|ed|ing)|paint(?:s|ed|ing)?|produc(?:e|es|ed|ing))\b/i,
  /\bimage\s*gen(?:eration)?\b/i,
  /\bmake me\b[\s\S]{0,48}\b(image|picture|photo|illustration|graphic|poster|cover|logo|icon|wallpaper)\b/i,
];
const NON_VISUAL_MODEL_PATTERNS = [
  /\b(?:data|database|db|api|json|schema|domain|object|class|entity|relational|sql)\s+model\b/i,
  /\bmodel\s+for\s+(?:a\s+|an\s+|the\s+)?(?:data|database|db|api|json|schema|domain|object|class|entity|relational|sql)\b/i,
  /\b(?:prisma|sqlalchemy|typeorm|mongoose)\s+model\b/i,
];
const EXPLICIT_VISUAL_REQUEST_PATTERN = /\b(image|picture|photo|illustration|graphic|diagram|schematic|visuali[sz]ation|chart|drawing|sketch|render|rendering|paint|painting|poster|mockup|infographic)\b/i;
const VISUAL_DELIVERY_PATTERNS = [
  /\b(show|display|pull\s+up|open|send|attach|bring\s+up)\b[\s\S]{0,72}\b(fig(?:ure)?|image|picture|photo|screenshot|diagram|chart|plot|graphic)\b/i,
  /\b(fig(?:ure)?|image|picture|photo|screenshot|diagram|chart|plot|graphic)\b[\s\S]{0,72}\b(show|display|pull\s+up|open|send|attach|bring\s+up)\b/i,
  /\b(show|display|pull\s+up|open|send|attach|bring\s+up)\b[\s\S]{0,72}\b(first|second|third|1st|2nd|3rd|one|two|three|[0-9]+)\s+(fig(?:ure)?|image|picture|photo|screenshot|diagram|chart|plot|graphic)\b/i,
];
const WEB_RESEARCH_PATTERNS = [
  /\bsearch(?:\s+the)?\s+web\b/i,
  /\bweb\s+search\b/i,
  /\bsearch\s+online\b/i,
  /\bbrowse(?:\s+the)?\s+web\b/i,
  /\blook\s+up\b/i,
  /\bgoogle\b/i,
  /\blatest\b/i,
  /\brecent\b/i,
  /\bcurrent\b/i,
  /\btoday\b/i,
  /\bnews\b/i,
];
const RICH_TEXT_DOCUMENT_EXTENSIONS = new Set([
  ".doc",
  ".docx",
  ".odt",
  ".pdf",
  ".rtf",
]);

function normalizeExtension(extension: string | undefined, fallback: string): string {
  const value = (extension || "").trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  return value.startsWith(".") ? value : `.${value}`;
}

function extensionFromMime(mimeType: string | undefined, fallback: string): string {
  switch ((mimeType || "").toLowerCase()) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "video/mp4":
      return ".mp4";
    case "video/quicktime":
      return ".mov";
    case "video/x-matroska":
      return ".mkv";
    case "video/webm":
      return ".webm";
    case "audio/aac":
      return ".aac";
    case "audio/aiff":
    case "audio/x-aiff":
      return ".aiff";
    case "audio/flac":
      return ".flac";
    case "audio/m4a":
    case "audio/mp4":
    case "audio/x-m4a":
      return ".m4a";
    case "audio/mpeg":
    case "audio/mp3":
      return ".mp3";
    case "audio/ogg":
      return ".ogg";
    case "audio/wav":
    case "audio/wave":
    case "audio/x-wav":
      return ".wav";
    case "audio/webm":
      return ".webm";
    case "application/json":
      return ".json";
    case "application/pdf":
      return ".pdf";
    case "text/plain":
      return ".txt";
    case "text/csv":
      return ".csv";
    case "text/markdown":
      return ".md";
    case "application/xml":
    case "text/xml":
      return ".xml";
    case "application/yaml":
    case "application/x-yaml":
    case "text/yaml":
      return ".yaml";
    default:
      return fallback;
  }
}

function isImageDocument(message: TelegramMessage): boolean {
  const mimeType = message.document?.mime_type?.toLowerCase() ?? "";
  if (mimeType.startsWith("image/")) {
    return true;
  }
  const extension = normalizeExtension(extname(message.document?.file_name ?? ""), "");
  return [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(extension);
}

function isVideoDocument(message: TelegramMessage): boolean {
  const mimeType = message.document?.mime_type?.toLowerCase() ?? "";
  if (mimeType.startsWith("video/")) {
    return true;
  }
  const extension = normalizeExtension(extname(message.document?.file_name ?? ""), "");
  return [".avi", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".webm"].includes(extension);
}

function isAudioDocument(message: TelegramMessage): boolean {
  const mimeType = message.document?.mime_type?.toLowerCase() ?? "";
  if (mimeType.startsWith("audio/")) {
    return true;
  }
  const extension = normalizeExtension(extname(message.document?.file_name ?? ""), "");
  return [".aac", ".aiff", ".flac", ".m4a", ".mp3", ".oga", ".ogg", ".opus", ".wav", ".weba", ".webm"].includes(extension);
}

function isTextLikeDocument(fileName: string | undefined, mimeType: string | undefined): boolean {
  const extension = normalizeExtension(extname(fileName ?? ""), "");
  if (TEXT_DOCUMENT_EXTENSIONS.has(extension)) {
    return true;
  }
  const normalizedMime = (mimeType || "").toLowerCase();
  return normalizedMime.startsWith("text/")
    || [
      "application/json",
      "application/ld+json",
      "application/xml",
      "application/yaml",
      "application/x-yaml",
      "application/javascript",
      "application/x-javascript",
      "application/typescript",
      "text/typescript",
    ].includes(normalizedMime);
}

function requestsSpokenReply(text: string | undefined): boolean {
  const value = text?.trim();
  if (!value) {
    return false;
  }
  return AUDIO_REPLY_PATTERNS.some(pattern => pattern.test(value));
}

export function requestsFastAsr(text: string | undefined): boolean {
  const value = text?.trim();
  if (!value) {
    return false;
  }
  return FAST_ASR_PATTERNS.some(pattern => pattern.test(value));
}

export function shouldCarryForwardFastAsrPreference(
  text: string | undefined,
  options?: { relaxed?: boolean },
): boolean {
  const value = text?.trim();
  if (!value) {
    return false;
  }
  if (requestsFastAsr(value)) {
    return true;
  }
  if (!options?.relaxed) {
    return false;
  }
  return FAST_ASR_RELAXED_PATTERNS.some(pattern => pattern.test(value));
}

export function looksLikeImageGenerationRequest(text: string | undefined): boolean {
  const value = text?.trim();
  if (!value) {
    return false;
  }
  if (
    !EXPLICIT_VISUAL_REQUEST_PATTERN.test(value)
    && NON_VISUAL_MODEL_PATTERNS.some(pattern => pattern.test(value))
  ) {
    return false;
  }
  return IMAGE_GENERATION_PATTERNS.some(pattern => pattern.test(value));
}

export function looksLikeVisualDeliveryRequest(text: string | undefined): boolean {
  const value = text?.trim();
  if (!value) {
    return false;
  }
  return VISUAL_DELIVERY_PATTERNS.some(pattern => pattern.test(value));
}

export type TelegramTurnWorkload =
  | "simple_text"
  | "web_research"
  | "image_generation"
  | "visual_delivery"
  | "audio_reply"
  | "image_input"
  | "media_or_file_input";

export function classifyTelegramTurnWorkload(
  task: Pick<QueuedTelegramTask, "kind" | "text" | "transcriptText" | "forceSpeak">,
): TelegramTurnWorkload {
  const searchText = [task.text, task.transcriptText]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
  if (WEB_RESEARCH_PATTERNS.some(pattern => pattern.test(searchText))) {
    return "web_research";
  }
  if (looksLikeImageGenerationRequest(searchText)) {
    return "image_generation";
  }
  if (looksLikeVisualDeliveryRequest(searchText)) {
    return "visual_delivery";
  }
  if (task.forceSpeak) {
    return "audio_reply";
  }
  switch (task.kind) {
    case "text":
      return "simple_text";
    case "image":
      return "image_input";
    default:
      return "media_or_file_input";
  }
}

function describeBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}

export function validateTelegramTaskForProcessing(task: QueuedTelegramTask): void {
  if (task.kind === "image" && task.imageFileSize && task.imageFileSize > MAX_IMAGE_INPUT_BYTES) {
    throw new Error(
      `Image attachment is too large for Telegram-to-Codex processing (${describeBytes(task.imageFileSize)} > ${describeBytes(MAX_IMAGE_INPUT_BYTES)}).`,
    );
  }
  if (task.kind === "document" && task.documentFileSize && task.documentFileSize > MAX_DOCUMENT_INPUT_BYTES) {
    throw new Error(
      `Document attachment is too large for Telegram-to-Codex processing (${describeBytes(task.documentFileSize)} > ${describeBytes(MAX_DOCUMENT_INPUT_BYTES)}).`,
    );
  }
  if ((task.kind === "voice" || task.kind === "audio") && task.mediaFileSize && task.mediaFileSize > MAX_AUDIO_INPUT_BYTES) {
    throw new Error(
      `Audio attachment is too large for Telegram-to-Codex processing (${describeBytes(task.mediaFileSize)} > ${describeBytes(MAX_AUDIO_INPUT_BYTES)}).`,
    );
  }
  if ((task.kind === "voice" || task.kind === "audio") && task.mediaDurationSeconds && task.mediaDurationSeconds > MAX_AUDIO_INPUT_DURATION_SECONDS) {
    throw new Error(
      `Audio attachment is too long for Telegram-to-Codex processing (${task.mediaDurationSeconds}s > ${MAX_AUDIO_INPUT_DURATION_SECONDS}s).`,
    );
  }
  if (task.kind === "video" && task.videoFileSize && task.videoFileSize > MAX_VIDEO_INPUT_BYTES) {
    throw new Error(
      `Video attachment is too large for Telegram-to-Codex processing (${describeBytes(task.videoFileSize)} > ${describeBytes(MAX_VIDEO_INPUT_BYTES)}).`,
    );
  }
  if (task.kind === "video" && task.videoDurationSeconds && task.videoDurationSeconds > MAX_VIDEO_INPUT_DURATION_SECONDS) {
    throw new Error(
      `Video attachment is too long for Telegram-to-Codex processing (${task.videoDurationSeconds}s > ${MAX_VIDEO_INPUT_DURATION_SECONDS}s).`,
    );
  }
}

export function maxAttachmentBytesForTask(task: Pick<QueuedTelegramTask, "kind">): number | null {
  switch (task.kind) {
    case "image":
      return MAX_IMAGE_INPUT_BYTES;
    case "document":
      return MAX_DOCUMENT_INPUT_BYTES;
    case "voice":
    case "audio":
      return MAX_AUDIO_INPUT_BYTES;
    case "video":
      return MAX_VIDEO_INPUT_BYTES;
    default:
      return null;
  }
}

function documentHeaderLines(task: QueuedTelegramTask, documentPath: string): string[] {
  const fileName = task.documentFileName || documentPath.split("/").pop() || "attachment";
  return [
    task.text && !task.text.startsWith("(")
      ? `The user sent a document with this request: ${task.text}`
      : "The user sent a document attachment.",
    `File name: ${fileName}`,
    `MIME type: ${task.documentMimeType || "unknown"}`,
    "A staged local copy is available to the bridge if deeper inspection is needed.",
  ];
}

function videoHeaderLines(task: QueuedTelegramTask, videoPath: string): string[] {
  const fileName = task.videoFileName || videoPath.split("/").pop() || "attachment";
  return [
    task.text && !task.text.startsWith("(")
      ? `The user sent a video with this request: ${task.text}`
      : "The user sent a video attachment.",
    `File name: ${fileName}`,
    `MIME type: ${task.videoMimeType || "unknown"}`,
    "A staged local copy and preview frame are available if deeper inspection is needed.",
  ];
}

function prependBridgeNotes(
  userPrompt: string,
  options: {
    automaticVoiceReply?: boolean;
    suggestImageTooling?: boolean;
  },
): string {
  const notes: string[] = [];
  if (options.automaticVoiceReply) {
    notes.push(
      "The user wants the answer back as audio. Write the normal final answer as usual; the bridge will synthesize and deliver a Telegram voice reply automatically. Do not call a separate speech-generation tool unless the user explicitly asks for a special audio variant.",
    );
  }
  if (options.suggestImageTooling) {
    notes.push(
      "If generating an image is the best way to satisfy this request, use the configured image-generation tool normally. The bridge will deliver any generated images back to Telegram automatically.",
    );
  }
  if (looksLikeBoundSessionRequest(userPrompt)) {
    notes.push(
      "This message is addressed to the currently bound Codex session. Treat phrases like \"the agent\", \"the assistant\", \"this session\", \"bound session\", and \"here\" as referring to this Codex session and its Telegram reply. If the user asks you to type, say, reply, or report something, answer directly in the final response unless doing so would be unsafe.",
    );
  }
  if (notes.length === 0) {
    return userPrompt;
  }
  return [
    "Bridge note (not from the user):",
    ...notes.map(note => `- ${note}`),
    "",
    userPrompt,
  ].join("\n");
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

async function buildDocumentPrompt(task: QueuedTelegramTask, documentPath: string): Promise<string> {
  const headerLines = documentHeaderLines(task, documentPath);
  let text: string | null = null;
  let extractionMethod: string | null = null;
  let details = await stat(documentPath);

  if (isTextLikeDocument(task.documentFileName, task.documentMimeType)) {
    const buffer = await readFile(documentPath);
    text = buffer.subarray(0, INLINE_DOCUMENT_BYTE_LIMIT).toString("utf8").replace(/\u0000/g, "");
    extractionMethod = "plain-text inline";
  } else {
    const extracted = await extractDocumentText(documentPath, task.documentFileName, task.documentMimeType);
    if (extracted) {
      text = extracted.text;
      extractionMethod = extracted.method;
      details = {
        ...details,
        size: Buffer.byteLength(extracted.text, "utf8"),
      };
    }
  }

  if (!text) {
    return [
      ...headerLines,
      "",
      "The file was staged locally for follow-up inspection if full contents are needed.",
    ].join("\n");
  }

  const excerpt = text.length > INLINE_DOCUMENT_CHAR_LIMIT ? `${text.slice(0, INLINE_DOCUMENT_CHAR_LIMIT)}\n...[truncated]` : text;
  const truncated = details.size > INLINE_DOCUMENT_BYTE_LIMIT || excerpt.endsWith("...[truncated]");
  return [
    ...headerLines,
    "",
    extractionMethod
      ? `Extraction method: ${extractionMethod}`
      : null,
    truncated
      ? `The document appears to be text. I included the first ${Math.min(excerpt.length, INLINE_DOCUMENT_CHAR_LIMIT)} characters below; ask the bridge to inspect the staged copy if more is needed.`
      : "The document appears to be text. Its contents are included below.",
    "",
    "```text",
    excerpt,
    "```",
  ].filter(Boolean).join("\n");
}

async function extractDocumentText(
  documentPath: string,
  fileName: string | undefined,
  mimeType: string | undefined,
): Promise<{ text: string; method: string } | null> {
  const extension = normalizeExtension(extname(fileName ?? ""), "");
  const normalizedMime = (mimeType || "").toLowerCase();

  if (extension === ".pdf" || normalizedMime === "application/pdf") {
    try {
      const { stdout } = await execFile("pdftotext", ["-layout", "-nopgbrk", documentPath, "-"], {
        maxBuffer: INLINE_DOCUMENT_CHAR_LIMIT * 8,
        timeout: DOCUMENT_EXTRACTION_TIMEOUT_MS,
      });
      const text = stdout.replace(/\u0000/g, "").trim();
      if (text) {
        return { text, method: "pdftotext" };
      }
    } catch {
      return null;
    }
  }

  if (
    RICH_TEXT_DOCUMENT_EXTENSIONS.has(extension)
    || [
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/rtf",
      "text/rtf",
      "application/vnd.oasis.opendocument.text",
    ].includes(normalizedMime)
  ) {
    try {
      const { stdout } = await execFile("textutil", ["-convert", "txt", "-stdout", documentPath], {
        maxBuffer: INLINE_DOCUMENT_CHAR_LIMIT * 8,
        timeout: DOCUMENT_EXTRACTION_TIMEOUT_MS,
      });
      const text = stdout.replace(/\u0000/g, "").trim();
      if (text) {
        return { text, method: "textutil" };
      }
    } catch {
      return null;
    }
  }

  return null;
}

export function imageDownloadPathForTask(task: Pick<QueuedTelegramTask, "id" | "imageFileName" | "imageMimeType">, inboundRoot: string): string {
  const extension = normalizeExtension(
    extname(task.imageFileName ?? "") || extensionFromMime(task.imageMimeType, ".jpg"),
    ".jpg",
  );
  return join(inboundRoot, `${task.id}${extension}`);
}

export function documentDownloadPathForTask(task: Pick<QueuedTelegramTask, "id" | "documentFileName" | "documentMimeType">, inboundRoot: string): string {
  const extension = normalizeExtension(
    extname(task.documentFileName ?? "") || extensionFromMime(task.documentMimeType, ".bin"),
    ".bin",
  );
  return join(inboundRoot, `${task.id}${extension}`);
}

export function buildTelegramTask(
  updateId: number,
  message: TelegramMessage,
  nextSpeakFlag: () => boolean,
  nextFastAsrFlag: () => boolean = () => false,
): QueuedTelegramTask | null {
  const taskText = message.caption?.trim() || message.text?.trim();
  const requestedSpokenReply = requestsSpokenReply(taskText);
  const requestedFastAsr = requestsFastAsr(taskText);
  const consumeSpeakIntent = () => {
    const explicitSpeakFlag = nextSpeakFlag();
    return requestedSpokenReply || explicitSpeakFlag;
  };
  const consumeFastAsrIntent = () => {
    const explicitFastAsrFlag = nextFastAsrFlag();
    return requestedFastAsr || explicitFastAsrFlag;
  };
  if (message.photo?.length) {
    const best = message.photo.at(-1);
    if (!best) {
      return null;
    }
    return {
      id: randomUUID(),
      updateId,
      chatId: String(message.chat.id),
      messageId: message.message_id,
      kind: "image",
      text: message.caption?.trim() || "Please inspect the attached image.",
      photoFileId: best.file_id,
      imageMimeType: "image/jpeg",
      ...(best.file_size ? { imageFileSize: best.file_size } : {}),
      forceSpeak: consumeSpeakIntent(),
      preferFastAsr: requestedFastAsr,
      createdAt: Date.now(),
    };
  }
  if (message.voice) {
    return {
      id: randomUUID(),
      updateId,
      chatId: String(message.chat.id),
      messageId: message.message_id,
      kind: "voice",
      text: message.caption?.trim() || "(voice message)",
      mediaFileId: message.voice.file_id,
      ...(message.voice.mime_type ? { mediaMimeType: message.voice.mime_type } : {}),
      ...(message.voice.file_size ? { mediaFileSize: message.voice.file_size } : {}),
      ...(message.voice.duration ? { mediaDurationSeconds: message.voice.duration } : {}),
      forceSpeak: consumeSpeakIntent(),
      preferFastAsr: consumeFastAsrIntent(),
      createdAt: Date.now(),
    };
  }
  if (message.audio) {
    return {
      id: randomUUID(),
      updateId,
      chatId: String(message.chat.id),
      messageId: message.message_id,
      kind: "audio",
      text: message.caption?.trim() || "(audio attachment)",
      mediaFileId: message.audio.file_id,
      ...(message.audio.file_name ? { mediaFileName: message.audio.file_name } : {}),
      ...(message.audio.mime_type ? { mediaMimeType: message.audio.mime_type } : {}),
      ...(message.audio.file_size ? { mediaFileSize: message.audio.file_size } : {}),
      ...(message.audio.duration ? { mediaDurationSeconds: message.audio.duration } : {}),
      forceSpeak: consumeSpeakIntent(),
      preferFastAsr: consumeFastAsrIntent(),
      createdAt: Date.now(),
    };
  }
  if (message.animation) {
    return {
      id: randomUUID(),
      updateId,
      chatId: String(message.chat.id),
      messageId: message.message_id,
      kind: "video",
      text: message.caption?.trim() || "Please inspect the attached animation.",
      videoFileId: message.animation.file_id,
      ...(message.animation.file_name ? { videoFileName: message.animation.file_name } : {}),
      ...(message.animation.mime_type ? { videoMimeType: message.animation.mime_type } : {}),
      ...(message.animation.file_size ? { videoFileSize: message.animation.file_size } : {}),
      ...(message.animation.duration ? { videoDurationSeconds: message.animation.duration } : {}),
      forceSpeak: consumeSpeakIntent(),
      preferFastAsr: consumeFastAsrIntent(),
      createdAt: Date.now(),
    };
  }
  if (message.video_note) {
    return {
      id: randomUUID(),
      updateId,
      chatId: String(message.chat.id),
      messageId: message.message_id,
      kind: "video",
      text: message.caption?.trim() || "Please inspect the attached video note.",
      videoFileId: message.video_note.file_id,
      videoMimeType: "video/mp4",
      ...(message.video_note.file_size ? { videoFileSize: message.video_note.file_size } : {}),
      ...(message.video_note.duration ? { videoDurationSeconds: message.video_note.duration } : {}),
      forceSpeak: consumeSpeakIntent(),
      preferFastAsr: consumeFastAsrIntent(),
      createdAt: Date.now(),
    };
  }
  if (message.video) {
    return {
      id: randomUUID(),
      updateId,
      chatId: String(message.chat.id),
      messageId: message.message_id,
      kind: "video",
      text: message.caption?.trim() || "Please inspect the attached video.",
      videoFileId: message.video.file_id,
      ...(message.video.file_name ? { videoFileName: message.video.file_name } : {}),
      ...(message.video.mime_type ? { videoMimeType: message.video.mime_type } : {}),
      ...(message.video.file_size ? { videoFileSize: message.video.file_size } : {}),
      ...(message.video.duration ? { videoDurationSeconds: message.video.duration } : {}),
      forceSpeak: consumeSpeakIntent(),
      preferFastAsr: consumeFastAsrIntent(),
      createdAt: Date.now(),
    };
  }
  if (message.document && isImageDocument(message)) {
    return {
      id: randomUUID(),
      updateId,
      chatId: String(message.chat.id),
      messageId: message.message_id,
      kind: "image",
      text: message.caption?.trim() || "Please inspect the attached image.",
      photoFileId: message.document.file_id,
      ...(message.document.file_name ? { imageFileName: message.document.file_name } : {}),
      ...(message.document.mime_type ? { imageMimeType: message.document.mime_type } : {}),
      ...(message.document.file_size ? { imageFileSize: message.document.file_size } : {}),
      forceSpeak: consumeSpeakIntent(),
      preferFastAsr: requestedFastAsr,
      createdAt: Date.now(),
    };
  }
  if (message.document && isVideoDocument(message)) {
    return {
      id: randomUUID(),
      updateId,
      chatId: String(message.chat.id),
      messageId: message.message_id,
      kind: "video",
      text: message.caption?.trim() || "Please inspect the attached video.",
      videoFileId: message.document.file_id,
      ...(message.document.file_name ? { videoFileName: message.document.file_name } : {}),
      ...(message.document.mime_type ? { videoMimeType: message.document.mime_type } : {}),
      ...(message.document.file_size ? { videoFileSize: message.document.file_size } : {}),
      forceSpeak: consumeSpeakIntent(),
      preferFastAsr: consumeFastAsrIntent(),
      createdAt: Date.now(),
    };
  }
  if (message.document && isAudioDocument(message)) {
    return {
      id: randomUUID(),
      updateId,
      chatId: String(message.chat.id),
      messageId: message.message_id,
      kind: "audio",
      text: message.caption?.trim() || "(audio attachment)",
      mediaFileId: message.document.file_id,
      ...(message.document.file_name ? { mediaFileName: message.document.file_name } : {}),
      ...(message.document.mime_type ? { mediaMimeType: message.document.mime_type } : {}),
      ...(message.document.file_size ? { mediaFileSize: message.document.file_size } : {}),
      forceSpeak: consumeSpeakIntent(),
      preferFastAsr: consumeFastAsrIntent(),
      createdAt: Date.now(),
    };
  }
  if (message.document) {
    return {
      id: randomUUID(),
      updateId,
      chatId: String(message.chat.id),
      messageId: message.message_id,
      kind: "document",
      text: message.caption?.trim() || "Please inspect the attached file.",
      documentFileId: message.document.file_id,
      ...(message.document.file_name ? { documentFileName: message.document.file_name } : {}),
      ...(message.document.mime_type ? { documentMimeType: message.document.mime_type } : {}),
      ...(message.document.file_size ? { documentFileSize: message.document.file_size } : {}),
      forceSpeak: consumeSpeakIntent(),
      preferFastAsr: requestedFastAsr,
      createdAt: Date.now(),
    };
  }
  if (message.text?.trim()) {
    return {
      id: randomUUID(),
      updateId,
      chatId: String(message.chat.id),
      messageId: message.message_id,
      kind: "text",
      text: message.text.trim(),
      forceSpeak: consumeSpeakIntent(),
      preferFastAsr: requestedFastAsr,
      createdAt: Date.now(),
    };
  }
  return null;
}

export interface BuildTurnInputsDeps {
  telegram: Pick<TelegramClient, "downloadFile" | "editMessageText">;
  registry: Pick<MediaRegistry, "transcribe">;
  artifacts: Pick<ArtifactStore, "writeArtifact">;
  inboundRoot: string;
  normalizedRoot: string;
  transcodeToWavImpl?: typeof transcodeToWav;
  extractVideoFrameImpl?: typeof extractVideoFrame;
  extractDocumentTextImpl?: typeof extractDocumentText;
  onTaskUpdated?: (task: QueuedTelegramTask) => void | Promise<void>;
}

async function transcribeTelegramMedia(
  registry: Pick<MediaRegistry, "transcribe">,
  options: {
    filePath: string;
    preferFastAsr: boolean;
  },
) {
  if (!options.preferFastAsr) {
    return await registry.transcribe({ filePath: options.filePath });
  }
  try {
    return await registry.transcribe({
      filePath: options.filePath,
      providerId: "openai",
      model: "gpt-4o-mini-transcribe",
    });
  } catch {
    return await registry.transcribe({ filePath: options.filePath });
  }
}

export async function buildTelegramTurnInputs(
  task: QueuedTelegramTask,
  placeholderMessageId: number | null,
  deps: BuildTurnInputsDeps,
): Promise<CodexTurnInput[]> {
  validateTelegramTaskForProcessing(task);
  switch (task.kind) {
    case "text":
      return [{
        type: "text",
        text: prependBridgeNotes(task.text, {
          automaticVoiceReply: Boolean(task.forceSpeak),
          suggestImageTooling: looksLikeImageGenerationRequest(task.text),
        }),
      }];
    case "image": {
      if (!placeholderMessageId) {
        throw new Error("Image task progress requires a Telegram placeholder message.");
      }
      const imagePath = task.stagedImagePath && existsSync(task.stagedImagePath)
        ? task.stagedImagePath
        : imageDownloadPathForTask(task, deps.inboundRoot);
      if (imagePath === task.stagedImagePath && existsSync(imagePath)) {
        return [
          {
            type: "text",
            text: prependBridgeNotes(task.text, {
              automaticVoiceReply: Boolean(task.forceSpeak),
            }),
          },
          { type: "localImage", path: imagePath },
        ];
      }
      await deps.telegram.editMessageText(task.chatId, placeholderMessageId, telegramProgressText("Downloading image."));
      await deps.telegram.downloadFile(task.photoFileId!, imagePath, {
        maxBytes: MAX_IMAGE_INPUT_BYTES,
        timeoutMs: TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
      });
      return [
        {
          type: "text",
          text: prependBridgeNotes(task.text, {
            automaticVoiceReply: Boolean(task.forceSpeak),
          }),
        },
        { type: "localImage", path: imagePath },
      ];
    }
    case "video": {
      if (!placeholderMessageId) {
        throw new Error("Video task progress requires a Telegram placeholder message.");
      }
      const extension = normalizeExtension(
        extname(task.videoFileName ?? "") || extensionFromMime(task.videoMimeType, ".mp4"),
        ".mp4",
      );
      const videoPath = task.videoPath && existsSync(task.videoPath)
        ? task.videoPath
        : join(deps.inboundRoot, `${task.id}${extension}`);
      const previewPath = task.mediaPreviewPath && existsSync(task.mediaPreviewPath)
        ? task.mediaPreviewPath
        : join(deps.inboundRoot, `${task.id}.jpg`);
      const normalizedPath = task.normalizedMediaPath && existsSync(task.normalizedMediaPath)
        ? task.normalizedMediaPath
        : join(deps.normalizedRoot, `${task.id}.wav`);
      const extractFrame = deps.extractVideoFrameImpl ?? extractVideoFrame;
      const transcode = deps.transcodeToWavImpl ?? transcodeToWav;
      if (!existsSync(videoPath)) {
        await deps.telegram.editMessageText(task.chatId, placeholderMessageId, telegramProgressText("Downloading video."));
        await deps.telegram.downloadFile(task.videoFileId!, videoPath, {
          maxBytes: MAX_VIDEO_INPUT_BYTES,
          timeoutMs: TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
        });
        task.videoPath = videoPath;
        await deps.onTaskUpdated?.(task);
      }
      if (!existsSync(previewPath)) {
        await deps.telegram.editMessageText(task.chatId, placeholderMessageId, telegramProgressText("Extracting preview frame."));
        await withTimeout(
          extractFrame(videoPath, previewPath),
          MEDIA_PREPARATION_TIMEOUT_MS,
          "Timed out extracting the Telegram video preview frame.",
        );
        task.mediaPreviewPath = previewPath;
        await deps.onTaskUpdated?.(task);
      }
      if (!existsSync(normalizedPath)) {
        await deps.telegram.editMessageText(task.chatId, placeholderMessageId, telegramProgressText("Normalizing video audio."));
        await withTimeout(
          transcode(videoPath, normalizedPath),
          MEDIA_PREPARATION_TIMEOUT_MS,
          "Timed out normalizing the Telegram video attachment.",
        );
        task.normalizedMediaPath = normalizedPath;
        await deps.onTaskUpdated?.(task);
      }
      if (!task.transcriptText) {
        await deps.telegram.editMessageText(
          task.chatId,
          placeholderMessageId,
          telegramProgressText(
            task.preferFastAsr
              ? "Transcribing video audio quickly."
              : "Transcribing video audio.",
          ),
        );
        const transcript = await withTimeout(
          transcribeTelegramMedia(deps.registry, {
            filePath: normalizedPath,
            preferFastAsr: Boolean(task.preferFastAsr),
          }),
          MEDIA_PREPARATION_TIMEOUT_MS,
          "Timed out transcribing the Telegram video attachment.",
        );
        task.transcriptText = transcript.text;
        const transcriptArtifact = await deps.artifacts.writeArtifact({
          modality: "transcript",
          providerId: transcript.providerId,
          source: "telegram",
          buffer: Buffer.from(transcript.text, "utf8"),
          fileExtension: "txt",
          mimeType: "text/plain",
          metadata: { taskId: task.id, kind: task.kind },
        });
        task.transcriptArtifactId = transcriptArtifact.id;
        task.transcriptArtifactPath = transcriptArtifact.path;
        await deps.onTaskUpdated?.(task);
      }
      const promptLines = videoHeaderLines(task, videoPath);
      const transcriptLines = task.transcriptText
        ? [
          "",
          "Transcript:",
          "```text",
          task.transcriptText,
          "```",
        ]
        : [];
      return [
        {
          type: "text",
          text: prependBridgeNotes(
            [...promptLines, ...transcriptLines].join("\n"),
            {
              automaticVoiceReply: Boolean(task.forceSpeak),
            },
          ),
        },
        { type: "localImage", path: previewPath },
      ];
    }
    case "document": {
      if (!placeholderMessageId) {
        throw new Error("Document task progress requires a Telegram placeholder message.");
      }
      const documentPath = task.documentPath && existsSync(task.documentPath)
        ? task.documentPath
        : documentDownloadPathForTask(task, deps.inboundRoot);
      if (!existsSync(documentPath)) {
        await deps.telegram.editMessageText(task.chatId, placeholderMessageId, telegramProgressText("Downloading file."));
        await deps.telegram.downloadFile(task.documentFileId!, documentPath, {
          maxBytes: MAX_DOCUMENT_INPUT_BYTES,
          timeoutMs: TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
        });
        task.documentPath = documentPath;
        await deps.onTaskUpdated?.(task);
      }
      return [{
        type: "text",
        text: prependBridgeNotes(await buildDocumentPromptWithExtractor(
          task,
          documentPath,
          deps.extractDocumentTextImpl ?? extractDocumentText,
        ), {
          automaticVoiceReply: Boolean(task.forceSpeak),
        }),
      }];
    }
    case "voice":
    case "audio": {
      if (!placeholderMessageId) {
        throw new Error("Audio task progress requires a Telegram placeholder message.");
      }
      const extension = task.kind === "voice"
        ? "ogg"
        : task.mediaFileName
          ? task.mediaFileName.split(".").pop() || "bin"
          : normalizeExtension(extensionFromMime(task.mediaMimeType, ".bin"), ".bin").slice(1);
      const originalPath = task.originalMediaPath && existsSync(task.originalMediaPath)
        ? task.originalMediaPath
        : join(deps.inboundRoot, `${task.id}.${extension}`);
      const normalizedPath = task.normalizedMediaPath && existsSync(task.normalizedMediaPath)
        ? task.normalizedMediaPath
        : join(deps.normalizedRoot, `${task.id}.wav`);
      const transcode = deps.transcodeToWavImpl ?? transcodeToWav;
      if (!existsSync(originalPath)) {
        await deps.telegram.editMessageText(task.chatId, placeholderMessageId, telegramProgressText("Downloading audio."));
        await deps.telegram.downloadFile(task.mediaFileId!, originalPath, {
          maxBytes: MAX_AUDIO_INPUT_BYTES,
          timeoutMs: TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
        });
        task.originalMediaPath = originalPath;
        await deps.onTaskUpdated?.(task);
      }
      if (!existsSync(normalizedPath)) {
        await deps.telegram.editMessageText(task.chatId, placeholderMessageId, telegramProgressText("Normalizing audio."));
        await withTimeout(
          transcode(originalPath, normalizedPath),
          MEDIA_PREPARATION_TIMEOUT_MS,
          "Timed out normalizing the Telegram audio attachment.",
        );
        task.normalizedMediaPath = normalizedPath;
        await deps.onTaskUpdated?.(task);
      }
      if (!task.transcriptText) {
        await deps.telegram.editMessageText(
          task.chatId,
          placeholderMessageId,
          telegramProgressText(
            task.preferFastAsr
              ? "Transcribing audio quickly."
              : "Transcribing audio.",
          ),
        );
        const transcript = await withTimeout(
          transcribeTelegramMedia(deps.registry, {
            filePath: normalizedPath,
            preferFastAsr: Boolean(task.preferFastAsr),
          }),
          MEDIA_PREPARATION_TIMEOUT_MS,
          "Timed out transcribing the Telegram audio attachment.",
        );
        task.transcriptText = transcript.text;
        const transcriptArtifact = await deps.artifacts.writeArtifact({
          modality: "transcript",
          providerId: transcript.providerId,
          source: "telegram",
          buffer: Buffer.from(transcript.text, "utf8"),
          fileExtension: "txt",
          mimeType: "text/plain",
          metadata: { taskId: task.id, kind: task.kind },
        });
        task.transcriptArtifactId = transcriptArtifact.id;
        task.transcriptArtifactPath = transcriptArtifact.path;
        await deps.onTaskUpdated?.(task);
      }
      return [{
        type: "text",
        text: prependBridgeNotes(
          task.text && !task.text.startsWith("(")
            ? `The user sent an audio message with this caption: ${task.text}\n\nTranscript:\n${task.transcriptText}`
            : `The user sent an audio message.\n\nTranscript:\n${task.transcriptText}`,
          {
            automaticVoiceReply: Boolean(task.forceSpeak),
          },
        ),
      }];
    }
    default:
      throw new Error(`Unsupported task kind: ${task.kind satisfies never}`);
  }
}

async function buildDocumentPromptWithExtractor(
  task: QueuedTelegramTask,
  documentPath: string,
  extractDocumentTextImpl: typeof extractDocumentText,
): Promise<string> {
  const original = extractDocumentText;
  if (extractDocumentTextImpl === original) {
    return buildDocumentPrompt(task, documentPath);
  }

  const headerLines = documentHeaderLines(task, documentPath);

  let text: string | null = null;
  let extractionMethod: string | null = null;
  let details = await stat(documentPath);

  if (isTextLikeDocument(task.documentFileName, task.documentMimeType)) {
    const buffer = await readFile(documentPath);
    text = buffer.subarray(0, INLINE_DOCUMENT_BYTE_LIMIT).toString("utf8").replace(/\u0000/g, "");
    extractionMethod = "plain-text inline";
  } else {
    const extracted = await extractDocumentTextImpl(documentPath, task.documentFileName, task.documentMimeType);
    if (extracted) {
      text = extracted.text;
      extractionMethod = extracted.method;
      details = {
        ...details,
        size: Buffer.byteLength(extracted.text, "utf8"),
      };
    }
  }

  if (!text) {
    return [
      ...headerLines,
      "",
      "The file was staged locally for follow-up inspection if full contents are needed.",
    ].join("\n");
  }

  const excerpt = text.length > INLINE_DOCUMENT_CHAR_LIMIT ? `${text.slice(0, INLINE_DOCUMENT_CHAR_LIMIT)}\n...[truncated]` : text;
  const truncated = details.size > INLINE_DOCUMENT_BYTE_LIMIT || excerpt.endsWith("...[truncated]");
  return [
    ...headerLines,
    "",
    extractionMethod
      ? `Extraction method: ${extractionMethod}`
      : null,
    truncated
      ? `The document appears to be text. I included the first ${Math.min(excerpt.length, INLINE_DOCUMENT_CHAR_LIMIT)} characters below; ask the bridge to inspect the staged copy if more is needed.`
      : "The document appears to be text. Its contents are included below.",
    "",
    "```text",
    excerpt,
    "```",
  ].filter(Boolean).join("\n");
}
