import { existsSync, realpathSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { extname, normalize, resolve } from "node:path";

const GENERATED_DOCUMENT_EXTENSIONS = new Set([
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
const GENERATED_VIDEO_EXTENSIONS = new Set([
  ".avi",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".webm",
]);
const GENERATED_IMAGE_EXTENSIONS = new Set([
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
]);
const GENERATED_AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
]);

const OUTPUT_CONTEXT_PATTERN = /\b(created?|generated?|wrote|written|saved|exported|attached|produced|rendered|recorded|captured|ready|available|stored|placed)\b|\b(?:file|path|output)\s*:/i;
const MARKDOWN_LINK_PATH_PATTERN = /\]\(([^)\n]+\.[A-Za-z0-9]+)\)/g;
const CODE_PATH_PATTERN = /`([^`\n]+\.[A-Za-z0-9]+)`/g;
const BARE_PATH_WITH_EXTENSION_PATTERN = /((?:\/|\.{1,2}\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.[A-Za-z0-9]+)/g;
const MAX_DOCUMENT_OUTPUT_BYTES = 20 * 1024 * 1024;
const MAX_REFERENCED_DOCUMENTS = 3;
const MAX_RECENT_IMAGE_SCAN_DEPTH = 2;

interface PathCandidate {
  raw: string;
  index: number;
}

function normalizeRoot(root: string): string {
  return normalize(resolve(root));
}

function normalizeRealRoot(root: string): string {
  try {
    return normalize(realpathSync(root));
  } catch {
    return normalizeRoot(root);
  }
}

function isWithinRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function supportedDocumentPath(candidate: string): boolean {
  return GENERATED_DOCUMENT_EXTENSIONS.has(extname(candidate).toLowerCase());
}

function supportedVideoPath(candidate: string): boolean {
  return GENERATED_VIDEO_EXTENSIONS.has(extname(candidate).toLowerCase());
}

function supportedImagePath(candidate: string): boolean {
  return GENERATED_IMAGE_EXTENSIONS.has(extname(candidate).toLowerCase());
}

function supportedAudioPath(candidate: string): boolean {
  return GENERATED_AUDIO_EXTENSIONS.has(extname(candidate).toLowerCase());
}

function cleanCandidatePath(candidate: string): string {
  return candidate.replace(/^[("'`]+|[)"'`]+$/g, "").replace(/[.,;:!?]+$/g, "");
}

function extractPathCandidates(line: string): PathCandidate[] {
  const candidates: PathCandidate[] = [];
  for (const match of line.matchAll(MARKDOWN_LINK_PATH_PATTERN)) {
    if (match.index === undefined || !match[1]) {
      continue;
    }
    candidates.push({ raw: match[1], index: match.index });
  }
  for (const match of line.matchAll(CODE_PATH_PATTERN)) {
    if (match.index === undefined || !match[1]) {
      continue;
    }
    candidates.push({ raw: match[1], index: match.index });
  }
  const maskedLine = line
    .replace(MARKDOWN_LINK_PATH_PATTERN, " ")
    .replace(CODE_PATH_PATTERN, " ");
  for (const match of maskedLine.matchAll(BARE_PATH_WITH_EXTENSION_PATTERN)) {
    if (match.index === undefined || !match[1]) {
      continue;
    }
    candidates.push({ raw: match[1], index: match.index });
  }
  return candidates;
}

function hasOutputContextBeforeCandidate(line: string, candidateIndex: number): boolean {
  return OUTPUT_CONTEXT_PATTERN.test(line.slice(0, candidateIndex));
}

function isBareOutputPathLine(line: string, candidate: string): boolean {
  const normalizedLine = cleanCandidatePath(line.trim().replace(/^\s*[-*\u2022]\s*/, ""));
  return normalizedLine === cleanCandidatePath(candidate);
}

function hasOutputContextForCandidate(line: string, candidate: PathCandidate): boolean {
  return hasOutputContextBeforeCandidate(line, candidate.index) || isBareOutputPathLine(line, candidate.raw);
}

function resolveCandidatePath(candidate: string, allowedRoots: string[]): string | null {
  if (candidate.startsWith("/")) {
    return normalize(resolve(candidate));
  }
  let fallback: string | null = null;
  for (const root of allowedRoots) {
    const resolvedCandidate = normalize(resolve(root, candidate));
    if (isWithinRoot(resolvedCandidate, root)) {
      if (existsSync(resolvedCandidate)) {
        return resolvedCandidate;
      }
      fallback ??= resolvedCandidate;
    }
  }
  return fallback;
}

export async function collectReferencedGeneratedDocuments(
  finalText: string,
  options: {
    allowedRoots: string[];
    blockedRoots?: string[];
    maxCount?: number;
    maxBytes?: number;
    minModifiedAtMs?: number;
  },
): Promise<string[]> {
  const allowedRoots = options.allowedRoots.map(normalizeRoot);
  const blockedRoots = (options.blockedRoots ?? []).map(normalizeRoot);
  const allowedRealRoots = options.allowedRoots.map(normalizeRealRoot);
  const blockedRealRoots = (options.blockedRoots ?? []).map(normalizeRealRoot);
  const maxCount = options.maxCount ?? MAX_REFERENCED_DOCUMENTS;
  const maxBytes = options.maxBytes ?? MAX_DOCUMENT_OUTPUT_BYTES;
  const minModifiedAtMs = options.minModifiedAtMs ?? 0;
  const candidates = new Set<string>();
  for (const line of finalText.split(/\r?\n/)) {
    for (const raw of extractPathCandidates(line)) {
      if (!hasOutputContextForCandidate(line, raw)) {
        continue;
      }
      const candidate = resolveCandidatePath(cleanCandidatePath(raw.raw), allowedRoots);
      if (!candidate) {
        continue;
      }
      if (!supportedDocumentPath(candidate)) {
        continue;
      }
      if (!allowedRoots.some(root => isWithinRoot(candidate, root))) {
        continue;
      }
      if (blockedRoots.some(root => isWithinRoot(candidate, root))) {
        continue;
      }
      candidates.add(candidate);
      if (candidates.size >= maxCount) {
        break;
      }
    }
    if (candidates.size >= maxCount) {
      break;
    }
  }

  const paths: string[] = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    const realCandidate = (() => {
      try {
        return normalize(realpathSync(candidate));
      } catch {
        return null;
      }
    })();
    if (!realCandidate) {
      continue;
    }
    if (!allowedRealRoots.some(root => isWithinRoot(realCandidate, root))) {
      continue;
    }
    if (blockedRealRoots.some(root => isWithinRoot(realCandidate, root))) {
      continue;
    }
    const details = await stat(candidate).catch(() => null);
    if (!details?.isFile() || details.size > maxBytes) {
      continue;
    }
    if (minModifiedAtMs > 0 && details.mtimeMs < minModifiedAtMs) {
      continue;
    }
    paths.push(candidate);
  }
  return paths;
}

export async function collectReferencedGeneratedVideos(
  finalText: string,
  options: {
    allowedRoots: string[];
    blockedRoots?: string[];
    maxCount?: number;
    maxBytes?: number;
    minModifiedAtMs?: number;
  },
): Promise<string[]> {
  const allowedRoots = options.allowedRoots.map(normalizeRoot);
  const blockedRoots = (options.blockedRoots ?? []).map(normalizeRoot);
  const allowedRealRoots = options.allowedRoots.map(normalizeRealRoot);
  const blockedRealRoots = (options.blockedRoots ?? []).map(normalizeRealRoot);
  const maxCount = options.maxCount ?? MAX_REFERENCED_DOCUMENTS;
  const maxBytes = options.maxBytes ?? MAX_DOCUMENT_OUTPUT_BYTES;
  const minModifiedAtMs = options.minModifiedAtMs ?? 0;
  const candidates = new Set<string>();
  for (const line of finalText.split(/\r?\n/)) {
    for (const raw of extractPathCandidates(line)) {
      if (!hasOutputContextForCandidate(line, raw)) {
        continue;
      }
      const candidate = resolveCandidatePath(cleanCandidatePath(raw.raw), allowedRoots);
      if (!candidate) {
        continue;
      }
      if (!supportedVideoPath(candidate)) {
        continue;
      }
      if (!allowedRoots.some(root => isWithinRoot(candidate, root))) {
        continue;
      }
      if (blockedRoots.some(root => isWithinRoot(candidate, root))) {
        continue;
      }
      candidates.add(candidate);
      if (candidates.size >= maxCount) {
        break;
      }
    }
    if (candidates.size >= maxCount) {
      break;
    }
  }

  const paths: string[] = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    const realCandidate = (() => {
      try {
        return normalize(realpathSync(candidate));
      } catch {
        return null;
      }
    })();
    if (!realCandidate) {
      continue;
    }
    if (!allowedRealRoots.some(root => isWithinRoot(realCandidate, root))) {
      continue;
    }
    if (blockedRealRoots.some(root => isWithinRoot(realCandidate, root))) {
      continue;
    }
    const details = await stat(candidate).catch(() => null);
    if (!details?.isFile() || details.size > maxBytes) {
      continue;
    }
    if (minModifiedAtMs > 0 && details.mtimeMs < minModifiedAtMs) {
      continue;
    }
    paths.push(candidate);
  }
  return paths;
}

export async function collectReferencedGeneratedImages(
  finalText: string,
  options: {
    allowedRoots: string[];
    blockedRoots?: string[];
    maxCount?: number;
    maxBytes?: number;
    minModifiedAtMs?: number;
  },
): Promise<string[]> {
  const allowedRoots = options.allowedRoots.map(normalizeRoot);
  const blockedRoots = (options.blockedRoots ?? []).map(normalizeRoot);
  const allowedRealRoots = options.allowedRoots.map(normalizeRealRoot);
  const blockedRealRoots = (options.blockedRoots ?? []).map(normalizeRealRoot);
  const maxCount = options.maxCount ?? MAX_REFERENCED_DOCUMENTS;
  const maxBytes = options.maxBytes ?? MAX_DOCUMENT_OUTPUT_BYTES;
  const minModifiedAtMs = options.minModifiedAtMs ?? 0;
  const candidates = new Set<string>();
  for (const line of finalText.split(/\r?\n/)) {
    for (const raw of extractPathCandidates(line)) {
      if (!hasOutputContextForCandidate(line, raw)) {
        continue;
      }
      const candidate = resolveCandidatePath(cleanCandidatePath(raw.raw), allowedRoots);
      if (!candidate) {
        continue;
      }
      if (!supportedImagePath(candidate)) {
        continue;
      }
      if (!allowedRoots.some(root => isWithinRoot(candidate, root))) {
        continue;
      }
      if (blockedRoots.some(root => isWithinRoot(candidate, root))) {
        continue;
      }
      candidates.add(candidate);
      if (candidates.size >= maxCount) {
        break;
      }
    }
    if (candidates.size >= maxCount) {
      break;
    }
  }

  const paths: string[] = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    const realCandidate = (() => {
      try {
        return normalize(realpathSync(candidate));
      } catch {
        return null;
      }
    })();
    if (!realCandidate) {
      continue;
    }
    if (!allowedRealRoots.some(root => isWithinRoot(realCandidate, root))) {
      continue;
    }
    if (blockedRealRoots.some(root => isWithinRoot(realCandidate, root))) {
      continue;
    }
    const details = await stat(candidate).catch(() => null);
    if (!details?.isFile() || details.size > maxBytes) {
      continue;
    }
    if (minModifiedAtMs > 0 && details.mtimeMs < minModifiedAtMs) {
      continue;
    }
    paths.push(candidate);
  }
  return paths;
}

export async function collectReferencedGeneratedAudio(
  finalText: string,
  options: {
    allowedRoots: string[];
    blockedRoots?: string[];
    maxCount?: number;
    maxBytes?: number;
    minModifiedAtMs?: number;
  },
): Promise<string[]> {
  const allowedRoots = options.allowedRoots.map(normalizeRoot);
  const blockedRoots = (options.blockedRoots ?? []).map(normalizeRoot);
  const allowedRealRoots = options.allowedRoots.map(normalizeRealRoot);
  const blockedRealRoots = (options.blockedRoots ?? []).map(normalizeRealRoot);
  const maxCount = options.maxCount ?? MAX_REFERENCED_DOCUMENTS;
  const maxBytes = options.maxBytes ?? MAX_DOCUMENT_OUTPUT_BYTES;
  const minModifiedAtMs = options.minModifiedAtMs ?? 0;
  const candidates = new Set<string>();
  for (const line of finalText.split(/\r?\n/)) {
    for (const raw of extractPathCandidates(line)) {
      if (!hasOutputContextForCandidate(line, raw)) {
        continue;
      }
      const candidate = resolveCandidatePath(cleanCandidatePath(raw.raw), allowedRoots);
      if (!candidate) {
        continue;
      }
      if (!supportedAudioPath(candidate)) {
        continue;
      }
      if (!allowedRoots.some(root => isWithinRoot(candidate, root))) {
        continue;
      }
      if (blockedRoots.some(root => isWithinRoot(candidate, root))) {
        continue;
      }
      candidates.add(candidate);
      if (candidates.size >= maxCount) {
        break;
      }
    }
    if (candidates.size >= maxCount) {
      break;
    }
  }

  const paths: string[] = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    const realCandidate = (() => {
      try {
        return normalize(realpathSync(candidate));
      } catch {
        return null;
      }
    })();
    if (!realCandidate) {
      continue;
    }
    if (!allowedRealRoots.some(root => isWithinRoot(realCandidate, root))) {
      continue;
    }
    if (blockedRealRoots.some(root => isWithinRoot(realCandidate, root))) {
      continue;
    }
    const details = await stat(candidate).catch(() => null);
    if (!details?.isFile() || details.size > maxBytes) {
      continue;
    }
    if (minModifiedAtMs > 0 && details.mtimeMs < minModifiedAtMs) {
      continue;
    }
    paths.push(candidate);
  }
  return paths;
}

export async function collectRecentGeneratedImages(options: {
  allowedRoots: string[];
  blockedRoots?: string[];
  maxCount?: number;
  maxBytes?: number;
  minModifiedAtMs?: number;
  maxDepth?: number;
}): Promise<string[]> {
  const allowedRoots = [...new Set(options.allowedRoots.map(normalizeRoot))];
  const blockedRoots = (options.blockedRoots ?? []).map(normalizeRoot);
  const allowedRealRoots = options.allowedRoots.map(normalizeRealRoot);
  const blockedRealRoots = (options.blockedRoots ?? []).map(normalizeRealRoot);
  const maxCount = options.maxCount ?? MAX_REFERENCED_DOCUMENTS;
  const maxBytes = options.maxBytes ?? MAX_DOCUMENT_OUTPUT_BYTES;
  const minModifiedAtMs = options.minModifiedAtMs ?? 0;
  const maxDepth = options.maxDepth ?? MAX_RECENT_IMAGE_SCAN_DEPTH;
  const paths: string[] = [];
  const seen = new Set<string>();

  async function consider(candidate: string): Promise<void> {
    if (paths.length >= maxCount) {
      return;
    }
    const normalizedCandidate = normalize(resolve(candidate));
    if (seen.has(normalizedCandidate)) {
      return;
    }
    seen.add(normalizedCandidate);
    if (!supportedImagePath(normalizedCandidate)) {
      return;
    }
    if (!allowedRoots.some(root => isWithinRoot(normalizedCandidate, root))) {
      return;
    }
    if (blockedRoots.some(root => isWithinRoot(normalizedCandidate, root))) {
      return;
    }
    const realCandidate = (() => {
      try {
        return normalize(realpathSync(normalizedCandidate));
      } catch {
        return null;
      }
    })();
    if (!realCandidate) {
      return;
    }
    if (!allowedRealRoots.some(root => isWithinRoot(realCandidate, root))) {
      return;
    }
    if (blockedRealRoots.some(root => isWithinRoot(realCandidate, root))) {
      return;
    }
    const details = await stat(normalizedCandidate).catch(() => null);
    if (!details?.isFile() || details.size > maxBytes) {
      return;
    }
    if (minModifiedAtMs > 0 && details.mtimeMs < minModifiedAtMs) {
      return;
    }
    paths.push(normalizedCandidate);
  }

  async function scan(root: string, depth: number): Promise<void> {
    if (paths.length >= maxCount) {
      return;
    }
    const normalizedRoot = normalize(resolve(root));
    if (!allowedRoots.some(allowed => isWithinRoot(normalizedRoot, allowed))) {
      return;
    }
    if (blockedRoots.some(blocked => isWithinRoot(normalizedRoot, blocked))) {
      return;
    }
    const entries = await readdir(normalizedRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (paths.length >= maxCount) {
        return;
      }
      const candidate = resolve(normalizedRoot, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) {
          await scan(candidate, depth + 1);
        }
        continue;
      }
      if (entry.isFile() || entry.isSymbolicLink()) {
        await consider(candidate);
      }
    }
  }

  for (const root of allowedRoots) {
    await scan(root, 0);
    if (paths.length >= maxCount) {
      break;
    }
  }

  return paths;
}

export function mimeTypeForGeneratedDocument(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".csv":
      return "text/csv";
    case ".doc":
      return "application/msword";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".md":
      return "text/markdown";
    case ".pdf":
      return "application/pdf";
    case ".ppt":
      return "application/vnd.ms-powerpoint";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".rtf":
      return "application/rtf";
    case ".tsv":
      return "text/tab-separated-values";
    case ".txt":
      return "text/plain";
    case ".xls":
      return "application/vnd.ms-excel";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}

export function mimeTypeForGeneratedVideo(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".avi":
      return "video/x-msvideo";
    case ".m4v":
      return "video/x-m4v";
    case ".mkv":
      return "video/x-matroska";
    case ".mov":
      return "video/quicktime";
    case ".mp4":
      return "video/mp4";
    case ".mpeg":
    case ".mpg":
      return "video/mpeg";
    case ".webm":
      return "video/webm";
    default:
      return "video/mp4";
  }
}

export function mimeTypeForGeneratedAudio(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".aac":
      return "audio/aac";
    case ".flac":
      return "audio/flac";
    case ".m4a":
      return "audio/mp4";
    case ".mp3":
      return "audio/mpeg";
    case ".oga":
    case ".ogg":
    case ".opus":
      return "audio/ogg";
    case ".wav":
      return "audio/wav";
    default:
      return "application/octet-stream";
  }
}
