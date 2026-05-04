import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { promisify } from "node:util";

const TEXT_DOCUMENT_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".csv", ".diff", ".env", ".go", ".h", ".hpp", ".html", ".java",
  ".js", ".json", ".jsonl", ".kt", ".log", ".md", ".markdown", ".mjs", ".py", ".rb", ".rs", ".sh", ".sql",
  ".svg", ".swift", ".toml", ".ts", ".tsx", ".txt", ".tsv", ".xml", ".yaml", ".yml", ".zsh",
]);

const RICH_TEXT_DOCUMENT_EXTENSIONS = new Set([
  ".doc",
  ".docx",
  ".odt",
  ".pdf",
  ".rtf",
]);

const PRESENTATION_DOCUMENT_EXTENSIONS = new Set([
  ".ppt",
  ".pptx",
]);

function decodeXmlEntities(text: string): string {
  return text
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'");
}

function xmlTextContent(xml: string): string {
  return decodeXmlEntities(
    xml
      .replaceAll(/<a:br\s*\/>/g, "\n")
      .replaceAll(/<\/a:p>/g, "\n")
      .replaceAll(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

async function extractPptxText(documentPath: string): Promise<{ text: string; method: string } | null> {
  try {
    const { stdout: listing } = await execFile("unzip", ["-Z1", documentPath], {
      maxBuffer: INLINE_DOCUMENT_CHAR_LIMIT * 8,
      timeout: 20_000,
    });
    const entries = listing
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => /^ppt\/(?:slides\/slide\d+\.xml|notesSlides\/notesSlide\d+\.xml)$/.test(line))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    if (entries.length === 0) {
      return null;
    }
    const chunks: string[] = [];
    for (const entry of entries) {
      const { stdout } = await execFile("unzip", ["-p", documentPath, entry], {
        maxBuffer: INLINE_DOCUMENT_CHAR_LIMIT * 8,
        timeout: 20_000,
      });
      const text = xmlTextContent(stdout);
      if (text) {
        chunks.push(text);
      }
    }
    if (chunks.length === 0) {
      return null;
    }
    return {
      text: chunks.join("\n\n"),
      method: "pptx-xml",
    };
  } catch {
    return null;
  }
}

async function extractLegacyPresentationText(documentPath: string): Promise<{ text: string; method: string } | null> {
  try {
    const { stdout } = await execFile("strings", ["-a", "-n", "4", documentPath], {
      maxBuffer: INLINE_DOCUMENT_CHAR_LIMIT * 8,
      timeout: 20_000,
    });
    const lines = stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length >= 4);
    if (lines.length === 0) {
      return null;
    }
    return {
      text: lines.join("\n"),
      method: "strings",
    };
  } catch {
    return null;
  }
}

const DOCUMENT_EXTRACTION_TIMEOUT_MS = 20_000;
const INLINE_DOCUMENT_BYTE_LIMIT = 64 * 1024;
const INLINE_DOCUMENT_CHAR_LIMIT = 32_000;
const execFile = promisify(execFileCallback);

function normalizeExtension(extension: string | undefined, fallback: string): string {
  const value = (extension || "").trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  return value.startsWith(".") ? value : `.${value}`;
}

export function isTextLikeDocument(fileName: string | undefined, mimeType: string | undefined): boolean {
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

export async function extractDocumentText(
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
    extension === ".pptx"
    || normalizedMime === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ) {
    return await extractPptxText(documentPath);
  }

  if (
    extension === ".ppt"
    || normalizedMime === "application/vnd.ms-powerpoint"
  ) {
    const extracted = await extractLegacyPresentationText(documentPath);
    if (extracted) {
      return extracted;
    }
  }

  if (
    RICH_TEXT_DOCUMENT_EXTENSIONS.has(extension)
    || PRESENTATION_DOCUMENT_EXTENSIONS.has(extension)
    || [
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
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

export function truncateDocumentText(text: string): { text: string; truncated: boolean } {
  const excerpt = text.length > INLINE_DOCUMENT_CHAR_LIMIT ? `${text.slice(0, INLINE_DOCUMENT_CHAR_LIMIT)}\n...[truncated]` : text;
  return {
    text: excerpt,
    truncated: text.length > INLINE_DOCUMENT_CHAR_LIMIT || Buffer.byteLength(text, "utf8") > INLINE_DOCUMENT_BYTE_LIMIT,
  };
}
