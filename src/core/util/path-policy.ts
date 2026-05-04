import { access, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";

const ALLOWED_AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".flac",
  ".m4a",
  ".mp3",
  ".mp4",
  ".mpeg",
  ".ogg",
  ".oga",
  ".opus",
  ".wav",
  ".webm",
]);
const ALLOWED_IMAGE_EXTENSIONS = new Set([
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
const ALLOWED_DOCUMENT_EXTENSIONS = new Set([
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
const ALLOWED_VIDEO_EXTENSIONS = new Set([
  ".avi",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".webm",
]);

const ALLOWED_INSPECTABLE_EXTENSIONS = new Set([
  ...ALLOWED_IMAGE_EXTENSIONS,
  ...ALLOWED_AUDIO_EXTENSIONS,
  ...ALLOWED_DOCUMENT_EXTENSIONS,
  ...ALLOWED_VIDEO_EXTENSIONS,
]);

export type InspectableFileModality = "audio" | "document" | "image" | "video";

function isWithinRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("../") && rel !== "..");
}

export async function resolveAllowedAudioPath(filePath: string, allowedRoots: string[]): Promise<string> {
  return resolveAllowedPath(filePath, allowedRoots, {
    allowedExtensions: ALLOWED_AUDIO_EXTENSIONS,
    outsideMessage: "Refusing to transcribe files outside the allowed roots",
    typeMessage: "Refusing to transcribe non-audio files",
  });
}

export async function resolveAllowedImagePath(filePath: string, allowedRoots: string[]): Promise<string> {
  return resolveAllowedPath(filePath, allowedRoots, {
    allowedExtensions: ALLOWED_IMAGE_EXTENSIONS,
    outsideMessage: "Refusing to view images outside the allowed roots",
    typeMessage: "Refusing to view non-image files",
  });
}

async function resolveAllowedPath(
  filePath: string,
  allowedRoots: string[],
  options: {
    allowedExtensions: Set<string>;
    outsideMessage: string;
    typeMessage: string;
  },
): Promise<string> {
  const candidatePaths = (() => {
    if (isAbsolute(filePath)) {
      return [resolve(filePath)];
    }

    const rootRelativeCandidates = allowedRoots.map(root => resolve(root, filePath));
    const cwdRelativeCandidate = resolve(filePath);
    const prefersAllowedRoots = !filePath.startsWith("./") && !filePath.startsWith("../");
    return prefersAllowedRoots
      ? [...rootRelativeCandidates, cwdRelativeCandidate]
      : [cwdRelativeCandidate, ...rootRelativeCandidates];
  })();

  let resolvedPath: string | null = null;
  let lastAccessError: unknown = null;
  for (const candidate of candidatePaths) {
    try {
      await access(candidate);
      resolvedPath = await realpath(candidate);
      break;
    } catch (error) {
      lastAccessError = error;
    }
  }
  if (!resolvedPath) {
    throw lastAccessError instanceof Error ? lastAccessError : new Error(`Unable to access ${filePath}`);
  }

  const resolvedRoots = await Promise.all(
    allowedRoots.map(async root => {
      const absoluteRoot = resolve(root);
      try {
        return await realpath(absoluteRoot);
      } catch {
        return absoluteRoot;
      }
    }),
  );

  if (!resolvedRoots.some(root => isWithinRoot(resolvedPath, root))) {
    throw new Error(`${options.outsideMessage}. Allowed roots: ${resolvedRoots.join(", ")}`);
  }

  const extension = extname(resolvedPath).toLowerCase();
  if (!options.allowedExtensions.has(extension)) {
    throw new Error(`${options.typeMessage}. Allowed extensions: ${Array.from(options.allowedExtensions).join(", ")}`);
  }

  return resolvedPath;
}

export async function resolveAllowedDocumentPath(filePath: string, allowedRoots: string[]): Promise<string> {
  return resolveAllowedPath(filePath, allowedRoots, {
    allowedExtensions: ALLOWED_DOCUMENT_EXTENSIONS,
    outsideMessage: "Refusing to view documents outside the allowed roots",
    typeMessage: "Refusing to view non-document files",
  });
}

export async function resolveAllowedVideoPath(filePath: string, allowedRoots: string[]): Promise<string> {
  return resolveAllowedPath(filePath, allowedRoots, {
    allowedExtensions: ALLOWED_VIDEO_EXTENSIONS,
    outsideMessage: "Refusing to view videos outside the allowed roots",
    typeMessage: "Refusing to view non-video files",
  });
}

export async function resolveAllowedInspectablePath(filePath: string, allowedRoots: string[]): Promise<string> {
  return resolveAllowedPath(filePath, allowedRoots, {
    allowedExtensions: ALLOWED_INSPECTABLE_EXTENSIONS,
    outsideMessage: "Refusing to inspect files outside the allowed roots",
    typeMessage: "Refusing to inspect unsupported files",
  });
}

export function inspectableFileModality(path: string): InspectableFileModality | null {
  const extension = extname(path).toLowerCase();
  if (ALLOWED_IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }
  if (ALLOWED_VIDEO_EXTENSIONS.has(extension)) {
    return "video";
  }
  if (ALLOWED_AUDIO_EXTENSIONS.has(extension)) {
    return "audio";
  }
  if (ALLOWED_DOCUMENT_EXTENSIONS.has(extension)) {
    return "document";
  }
  return null;
}

export function mimeTypeForInspectablePath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".aac":
      return "audio/aac";
    case ".avi":
      return "video/x-msvideo";
    case ".avif":
      return "image/avif";
    case ".bmp":
      return "image/bmp";
    case ".csv":
      return "text/csv";
    case ".doc":
      return "application/msword";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".flac":
      return "audio/flac";
    case ".gif":
      return "image/gif";
    case ".heic":
      return "image/heic";
    case ".jpeg":
    case ".jpg":
      return "image/jpeg";
    case ".m4a":
      return "audio/mp4";
    case ".m4v":
      return "video/x-m4v";
    case ".mkv":
      return "video/x-matroska";
    case ".md":
      return "text/markdown";
    case ".mov":
      return "video/quicktime";
    case ".mp3":
      return "audio/mpeg";
    case ".mp4":
      return inspectableFileModality(path) === "video" ? "video/mp4" : "audio/mp4";
    case ".mpeg":
    case ".mpg":
      return inspectableFileModality(path) === "video" ? "video/mpeg" : "audio/mpeg";
    case ".oga":
    case ".ogg":
      return "audio/ogg";
    case ".opus":
      return "audio/ogg";
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".ppt":
      return "application/vnd.ms-powerpoint";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".rtf":
      return "application/rtf";
    case ".svg":
      return "image/svg+xml";
    case ".tif":
    case ".tiff":
      return "image/tiff";
    case ".tsv":
      return "text/tab-separated-values";
    case ".txt":
      return "text/plain";
    case ".wav":
      return "audio/wav";
    case ".webm":
      return inspectableFileModality(path) === "video" ? "video/webm" : "audio/webm";
    case ".webp":
      return "image/webp";
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

export async function resolveAllowedInspectableFile(
  filePath: string,
  allowedRoots: string[],
): Promise<{ path: string; modality: InspectableFileModality; mimeType: string }> {
  const resolvedPath = await resolveAllowedInspectablePath(filePath, allowedRoots);
  const modality = inspectableFileModality(resolvedPath);
  if (!modality) {
    throw new Error("Refusing to inspect unsupported files");
  }
  return {
    path: resolvedPath,
    modality,
    mimeType: mimeTypeForInspectablePath(resolvedPath),
  };
}
