import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "vitest";

import {
  collectRecentGeneratedImages,
  collectReferencedGeneratedAudio,
  collectReferencedGeneratedDocuments,
  collectReferencedGeneratedImages,
  collectReferencedGeneratedVideos,
  mimeTypeForGeneratedAudio,
  mimeTypeForGeneratedDocument,
} from "../src/core/telegram/generated-files.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("collectReferencedGeneratedDocuments", () => {
  test("collects generated document paths referenced in final text within allowed roots", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-generated-files-"));
    tempRoots.push(root);
    const pdfPath = join(root, "report.pdf");
    const mdPath = join(root, "notes.md");
    writeFileSync(pdfPath, "%PDF-1.7 stub");
    writeFileSync(mdPath, "# Notes\n");

    const documents = await collectReferencedGeneratedDocuments(
      [
        `Created the report at ${pdfPath}.`,
        `Also exported notes [notes](${mdPath}).`,
      ].join("\n"),
      { allowedRoots: [root] },
    );

    expect(documents.sort()).toEqual([mdPath, pdfPath].sort());
  });

  test("resolves safe relative output paths against the allowed root", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-generated-files-relative-"));
    tempRoots.push(root);
    const outputDir = join(root, "exports");
    const relativePath = "exports/report.pdf";
    const absolutePath = join(root, relativePath);
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(absolutePath, "%PDF-1.7 stub");

    const documents = await collectReferencedGeneratedDocuments(
      `Saved the finished report to ${relativePath}.`,
      { allowedRoots: [root] },
    );

    expect(documents).toEqual([absolutePath]);
  });

  test("collects a final answer that is only an allowed document path", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-generated-doc-path-only-"));
    tempRoots.push(root);
    const pdfPath = join(root, "report.pdf");
    writeFileSync(pdfPath, "%PDF-1.7 stub");

    const documents = await collectReferencedGeneratedDocuments(
      pdfPath,
      { allowedRoots: [root], minModifiedAtMs: Date.now() - 10_000 },
    );

    expect(documents).toEqual([pdfPath]);
  });

  test("supports markdown-link and backtick paths with spaces", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-generated-files-spaces-"));
    tempRoots.push(root);
    const linkedPath = join(root, "Quarterly Report.pdf");
    const codePath = join(root, "exports", "meeting notes.md");
    mkdirSync(join(root, "exports"), { recursive: true });
    writeFileSync(linkedPath, "%PDF-1.7 stub");
    writeFileSync(codePath, "# Meeting notes\n");

    const documents = await collectReferencedGeneratedDocuments(
      [
        `Created the PDF [Quarterly Report](${linkedPath}).`,
        `Saved the notes to \`exports/meeting notes.md\`.`,
      ].join("\n"),
      { allowedRoots: [root] },
    );

    expect(documents.sort()).toEqual([codePath, linkedPath].sort());
  });

  test("ignores unsupported, blocked, and non-output references", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-generated-files-ignore-"));
    tempRoots.push(root);
    const blockedRoot = join(root, ".bridge-data");
    const allowedPdf = join(root, "summary.pdf");
    const blockedPdf = join(blockedRoot, "internal.pdf");
    const mentionedWithoutOutputVerb = join(root, "README.md");
    mkdirSync(blockedRoot, { recursive: true });
    writeFileSync(allowedPdf, "%PDF-1.7 stub");
    writeFileSync(blockedPdf, "%PDF-1.7 stub");
    writeFileSync(mentionedWithoutOutputVerb, "# repo readme\n");

    const documents = await collectReferencedGeneratedDocuments(
      [
        `Saved summary to ${allowedPdf}.`,
        `Created internal artifact at ${blockedPdf}.`,
        `I reviewed ${mentionedWithoutOutputVerb} while working.`,
      ].join("\n"),
      { allowedRoots: [root], blockedRoots: [blockedRoot] },
    );

    expect(documents).toEqual([allowedPdf]);
  });

  test("requires output context before each individual candidate, not just somewhere on the line", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-generated-files-context-window-"));
    tempRoots.push(root);
    const reviewedPath = join(root, "README.md");
    const exportedPath = join(root, "report.pdf");
    writeFileSync(reviewedPath, "# README\n");
    writeFileSync(exportedPath, "%PDF-1.7 stub");

    const documents = await collectReferencedGeneratedDocuments(
      `I reviewed ${reviewedPath} and then created ${exportedPath}.`,
      { allowedRoots: [root] },
    );

    expect(documents).toEqual([exportedPath]);
  });

  test("requires the referenced file to have been touched during the current turn window", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-generated-files-mtime-"));
    tempRoots.push(root);
    const oldPath = join(root, "stale-report.pdf");
    const newPath = join(root, "fresh-report.pdf");
    writeFileSync(oldPath, "%PDF-1.7 old");
    writeFileSync(newPath, "%PDF-1.7 new");
    const nowSeconds = Date.now() / 1000;
    utimesSync(oldPath, nowSeconds - 120, nowSeconds - 120);
    utimesSync(newPath, nowSeconds, nowSeconds);

    const documents = await collectReferencedGeneratedDocuments(
      [
        `Saved the stale file to ${oldPath}.`,
        `Created the fresh file at ${newPath}.`,
      ].join("\n"),
      { allowedRoots: [root], minModifiedAtMs: Date.now() - 10_000 },
    );

    expect(documents).toEqual([newPath]);
  });

  test("ignores symlinked files that escape the allowed root", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-generated-files-symlink-"));
    const outsideRoot = mkdtempSync(join(tmpdir(), "telegram-codex-generated-files-outside-"));
    tempRoots.push(root);
    tempRoots.push(outsideRoot);
    const escapedPath = join(outsideRoot, "secret.pdf");
    const linkedPath = join(root, "exports", "linked-secret.pdf");
    mkdirSync(join(root, "exports"), { recursive: true });
    writeFileSync(escapedPath, "%PDF-1.7 secret");
    symlinkSync(escapedPath, linkedPath);

    const documents = await collectReferencedGeneratedDocuments(
      `Created the exported file at ${linkedPath}.`,
      { allowedRoots: [root] },
    );

    expect(documents).toEqual([]);
  });
});

describe("mimeTypeForGeneratedDocument", () => {
  test("returns expected types for common generated outputs", () => {
    expect(mimeTypeForGeneratedDocument("/tmp/report.pdf")).toBe("application/pdf");
    expect(mimeTypeForGeneratedDocument("/tmp/table.csv")).toBe("text/csv");
    expect(mimeTypeForGeneratedDocument("/tmp/unknown.bin")).toBe("application/octet-stream");
  });
});

describe("collectReferencedGeneratedImages", () => {
  test("collects generated image paths referenced in final text", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-generated-images-"));
    tempRoots.push(root);
    const pngPath = join(root, "output", "figure.png");
    const jpgPath = join(root, "output", "cover.jpg");
    mkdirSync(join(root, "output"), { recursive: true });
    writeFileSync(pngPath, "png");
    writeFileSync(jpgPath, "jpg");

    const images = await collectReferencedGeneratedImages(
      [
        `Created the figure at ${pngPath}.`,
        `Output: \`output/cover.jpg\`.`,
      ].join("\n"),
      { allowedRoots: [root] },
    );

    expect(images.sort()).toEqual([jpgPath, pngPath].sort());
  });

  test("ignores images outside allowed roots through symlinks", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-generated-images-symlink-"));
    const outsideRoot = mkdtempSync(join(tmpdir(), "telegram-codex-generated-images-outside-"));
    tempRoots.push(root);
    tempRoots.push(outsideRoot);
    const escapedPath = join(outsideRoot, "private.png");
    const linkedPath = join(root, "output", "private.png");
    mkdirSync(join(root, "output"), { recursive: true });
    writeFileSync(escapedPath, "png");
    symlinkSync(escapedPath, linkedPath);

    const images = await collectReferencedGeneratedImages(
      `Generated the figure at ${linkedPath}.`,
      { allowedRoots: [root] },
    );

    expect(images).toEqual([]);
  });

  test("collects a final answer that is only an allowed image path", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-generated-image-path-only-"));
    tempRoots.push(root);
    const imagePath = join(root, "figure1.png");
    writeFileSync(imagePath, "png");

    const images = await collectReferencedGeneratedImages(
      imagePath,
      { allowedRoots: [root], minModifiedAtMs: Date.now() - 10_000 },
    );

    expect(images).toEqual([imagePath]);
  });

  test("collects a bare generated image filename from a Unicode bullet list", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-generated-image-bullet-"));
    tempRoots.push(root);
    const imagePath = join(root, "output", "cover.png");
    mkdirSync(join(root, "output"), { recursive: true });
    writeFileSync(imagePath, "png");

    const images = await collectReferencedGeneratedImages(
      [
        "Generated image:",
        "\u2022 output/cover.png",
      ].join("\n"),
      { allowedRoots: [root] },
    );

    expect(images).toEqual([imagePath]);
  });
});

describe("collectReferencedGeneratedAudio", () => {
  test("collects generated audio paths referenced in final text", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-generated-audio-"));
    tempRoots.push(root);
    const wavPath = join(root, "output", "narration.wav");
    const mp3Path = join(root, "output", "summary.mp3");
    mkdirSync(join(root, "output"), { recursive: true });
    writeFileSync(wavPath, "wav");
    writeFileSync(mp3Path, "mp3");

    const audio = await collectReferencedGeneratedAudio(
      [
        `Recorded narration at ${wavPath}.`,
        `Saved the audio file: output/summary.mp3.`,
      ].join("\n"),
      { allowedRoots: [root] },
    );

    expect(audio.sort()).toEqual([mp3Path, wavPath].sort());
  });
});

describe("collectRecentGeneratedImages", () => {
  test("scans recent image outputs inside allowed roots with depth and mtime limits", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-recent-images-"));
    tempRoots.push(root);
    const oldPath = join(root, "old.png");
    const shallowPath = join(root, "output", "figure.png");
    const deepPath = join(root, "output", "nested", "too-deep.png");
    mkdirSync(join(root, "output", "nested"), { recursive: true });
    writeFileSync(oldPath, "old");
    writeFileSync(shallowPath, "new");
    writeFileSync(deepPath, "deep");
    const nowSeconds = Date.now() / 1000;
    utimesSync(oldPath, nowSeconds - 120, nowSeconds - 120);

    const images = await collectRecentGeneratedImages({
      allowedRoots: [root],
      minModifiedAtMs: Date.now() - 10_000,
      maxDepth: 1,
    });

    expect(images).toEqual([shallowPath]);
  });
});

describe("mimeTypeForGeneratedAudio", () => {
  test("returns expected types for common generated audio outputs", () => {
    expect(mimeTypeForGeneratedAudio("/tmp/narration.wav")).toBe("audio/wav");
    expect(mimeTypeForGeneratedAudio("/tmp/summary.mp3")).toBe("audio/mpeg");
    expect(mimeTypeForGeneratedAudio("/tmp/voice.ogg")).toBe("audio/ogg");
    expect(mimeTypeForGeneratedAudio("/tmp/unknown.bin")).toBe("application/octet-stream");
  });
});

describe("collectReferencedGeneratedVideos", () => {
  test("collects generated video paths referenced in final text within allowed roots", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-generated-videos-"));
    tempRoots.push(root);
    const mp4Path = join(root, "demo.mp4");
    const movPath = join(root, "exports", "teaser.mov");
    mkdirSync(join(root, "exports"), { recursive: true });
    writeFileSync(mp4Path, "video stub");
    writeFileSync(movPath, "video stub");

    const videos = await collectReferencedGeneratedVideos(
      [
        `Rendered the demo video at ${mp4Path}.`,
        `The teaser is available at \`exports/teaser.mov\`.`,
      ].join("\n"),
      { allowedRoots: [root] },
    );

    expect(videos.sort()).toEqual([movPath, mp4Path].sort());
  });

  test("ignores blocked or non-output video references", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-generated-videos-ignore-"));
    tempRoots.push(root);
    const blockedRoot = join(root, ".bridge-data");
    const kept = join(root, "clip.mp4");
    const blocked = join(blockedRoot, "internal.mov");
    const reviewed = join(root, "reference.mp4");
    mkdirSync(blockedRoot, { recursive: true });
    writeFileSync(kept, "video stub");
    writeFileSync(blocked, "video stub");
    writeFileSync(reviewed, "video stub");

    const videos = await collectReferencedGeneratedVideos(
      [
        `Captured the clip at ${kept}.`,
        `Saved internal output at ${blocked}.`,
        `I reviewed ${reviewed} while editing.`,
      ].join("\n"),
      { allowedRoots: [root], blockedRoots: [blockedRoot] },
    );

    expect(videos).toEqual([kept]);
  });
});
