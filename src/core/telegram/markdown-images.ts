export interface MarkdownImageReference {
  altText: string;
  rawPath: string;
}

const MARKDOWN_IMAGE_PATTERN = /!\[([^\]\n]*)\]\(([^)\n]+)\)/g;
const MARKDOWN_LINK_PATTERN = /\[([^\]\n]+)\]\(([^)\n]+)\)/g;

function normalizeMarkdownImagePath(rawPath: string): string {
  const trimmed = rawPath.trim().replace(/^<|>$/g, "");
  const titleMatch = /^(.*?)(?:\s+"[^"]*")?$/.exec(trimmed);
  return (titleMatch?.[1] ?? trimmed).trim();
}

function looksLikeImagePath(rawPath: string): boolean {
  const normalized = normalizeMarkdownImagePath(rawPath);
  return /\.(?:gif|jpe?g|png|svg|webp)$/i.test(normalized);
}

export function extractMarkdownImageReferences(text: string): {
  cleanedText: string;
  references: MarkdownImageReference[];
} {
  const references: MarkdownImageReference[] = [];
  const cleanedLines: string[] = [];

  for (const line of text.split(/\r?\n/)) {
    const inlineImageMatches = [...line.matchAll(MARKDOWN_IMAGE_PATTERN)];
    const linkedImageMatches = [...line.matchAll(MARKDOWN_LINK_PATTERN)]
      .filter(match => {
        if (match.index === undefined || !match[2]) {
          return false;
        }
        const previousChar = match.index > 0 ? line[match.index - 1] : "";
        return previousChar !== "!" && looksLikeImagePath(match[2]);
      });
    const lineReferences = [...inlineImageMatches, ...linkedImageMatches];
    if (lineReferences.length === 0) {
      cleanedLines.push(line);
      continue;
    }

    for (const match of lineReferences) {
      const altText = (match[1] ?? "").trim();
      const rawPath = normalizeMarkdownImagePath(match[2] ?? "");
      if (!rawPath) {
        continue;
      }
      references.push({ altText, rawPath });
    }

    const strippedLine = line
      .replace(MARKDOWN_IMAGE_PATTERN, "")
      .replace(MARKDOWN_LINK_PATTERN, (match, _label: string, rawPath: string, offset: number, fullLine: string) => {
        const previousChar = offset > 0 ? fullLine[offset - 1] : "";
        if (previousChar === "!" || !looksLikeImagePath(rawPath)) {
          return match;
        }
        return "";
      })
      .trim();
    if (strippedLine.length > 0) {
      cleanedLines.push(
        line
          .replace(MARKDOWN_IMAGE_PATTERN, (_match, altText: string) => altText.trim())
          .replace(MARKDOWN_LINK_PATTERN, (match, label: string, rawPath: string, offset: number, fullLine: string) => {
            const previousChar = offset > 0 ? fullLine[offset - 1] : "";
            if (previousChar === "!" || !looksLikeImagePath(rawPath)) {
              return match;
            }
            return label.trim();
          }),
      );
    }
  }

  return {
    cleanedText: cleanedLines.join("\n"),
    references,
  };
}
