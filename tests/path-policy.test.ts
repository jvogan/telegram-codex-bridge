import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "vitest";

import {
  inspectableFileModality,
  mimeTypeForInspectablePath,
  resolveAllowedAudioPath,
  resolveAllowedDocumentPath,
  resolveAllowedImagePath,
  resolveAllowedInspectableFile,
  resolveAllowedInspectablePath,
  resolveAllowedVideoPath,
} from "../src/core/util/path-policy.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "telegram-codex-bridge-paths-"));
  tempRoots.push(root);
  return root;
}

describe("resolveAllowedAudioPath", () => {
  test("accepts an audio file inside an allowed root", async () => {
    const root = makeRoot();
    const filePath = join(root, "sample.wav");
    writeFileSync(filePath, "wav");

    await expect(resolveAllowedAudioPath(filePath, [root])).resolves.toBe(realpathSync(filePath));
  });

  test("rejects non-audio files even inside an allowed root", async () => {
    const root = makeRoot();
    const filePath = join(root, "secret.txt");
    writeFileSync(filePath, "secret");

    await expect(resolveAllowedAudioPath(filePath, [root])).rejects.toThrow("Refusing to transcribe non-audio files");
  });

  test("rejects files outside the allowed roots", async () => {
    const allowedRoot = makeRoot();
    const otherRoot = makeRoot();
    const filePath = join(otherRoot, "sample.wav");
    writeFileSync(filePath, "wav");

    await expect(resolveAllowedAudioPath(filePath, [allowedRoot])).rejects.toThrow("Refusing to transcribe files outside the allowed roots");
  });
});

describe("resolveAllowedImagePath", () => {
  test("accepts an image file inside an allowed root", async () => {
    const root = makeRoot();
    const filePath = join(root, "sample.png");
    writeFileSync(filePath, "png");

    await expect(resolveAllowedImagePath(filePath, [root])).resolves.toBe(realpathSync(filePath));
  });

  test("rejects non-image files even inside an allowed root", async () => {
    const root = makeRoot();
    const filePath = join(root, "secret.txt");
    writeFileSync(filePath, "secret");

    await expect(resolveAllowedImagePath(filePath, [root])).rejects.toThrow("Refusing to view non-image files");
  });

  test("rejects files outside the allowed roots", async () => {
    const allowedRoot = makeRoot();
    const otherRoot = makeRoot();
    const filePath = join(otherRoot, "sample.png");
    writeFileSync(filePath, "png");

    await expect(resolveAllowedImagePath(filePath, [allowedRoot])).rejects.toThrow("Refusing to view images outside the allowed roots");
  });

  test("prefers filename-only matches inside allowed roots before the process cwd", async () => {
    const allowedRoot = makeRoot();
    const otherRoot = makeRoot();
    const allowedPath = join(allowedRoot, "figure1.jpg");
    const cwdPath = join(otherRoot, "figure1.jpg");
    writeFileSync(allowedPath, "allowed");
    writeFileSync(cwdPath, "cwd");

    const previousCwd = process.cwd();
    process.chdir(otherRoot);
    try {
      await expect(resolveAllowedImagePath("figure1.jpg", [allowedRoot])).resolves.toBe(realpathSync(allowedPath));
    } finally {
      process.chdir(previousCwd);
    }
  });
});

describe("resolveAllowedDocumentPath", () => {
  test("accepts a document file inside an allowed root", async () => {
    const root = makeRoot();
    const filePath = join(root, "sample.pdf");
    writeFileSync(filePath, "pdf");

    await expect(resolveAllowedDocumentPath(filePath, [root])).resolves.toBe(realpathSync(filePath));
  });

  test("rejects non-document files even inside an allowed root", async () => {
    const root = makeRoot();
    const filePath = join(root, "secret.png");
    writeFileSync(filePath, "png");

    await expect(resolveAllowedDocumentPath(filePath, [root])).rejects.toThrow("Refusing to view non-document files");
  });
});

describe("resolveAllowedVideoPath", () => {
  test("accepts a video file inside an allowed root", async () => {
    const root = makeRoot();
    const filePath = join(root, "sample.mp4");
    writeFileSync(filePath, "mp4");

    await expect(resolveAllowedVideoPath(filePath, [root])).resolves.toBe(realpathSync(filePath));
  });

  test("rejects non-video files even inside an allowed root", async () => {
    const root = makeRoot();
    const filePath = join(root, "secret.txt");
    writeFileSync(filePath, "secret");

    await expect(resolveAllowedVideoPath(filePath, [root])).rejects.toThrow("Refusing to view non-video files");
  });
});

describe("resolveAllowedInspectableFile", () => {
  test("returns modality and mime type for an allowed document", async () => {
    const root = makeRoot();
    const filePath = join(root, "deck.pptx");
    writeFileSync(filePath, "pptx");

    await expect(resolveAllowedInspectableFile(filePath, [root])).resolves.toEqual({
      path: realpathSync(filePath),
      modality: "document",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
  });
});

describe("inspectable file helpers", () => {
  test("classifies video before overlapping audio extensions", () => {
    expect(inspectableFileModality("clip.mp4")).toBe("video");
    expect(mimeTypeForInspectablePath("clip.mp4")).toBe("video/mp4");
  });

  test("returns expected mime types for common image and audio formats", () => {
    expect(mimeTypeForInspectablePath("photo.png")).toBe("image/png");
    expect(mimeTypeForInspectablePath("voice.ogg")).toBe("audio/ogg");
  });
});

describe("resolveAllowedInspectablePath", () => {
  test("accepts an inspectable file inside an allowed root", async () => {
    const root = makeRoot();
    const filePath = join(root, "sample.txt");
    writeFileSync(filePath, "text");

    await expect(resolveAllowedInspectablePath(filePath, [root])).resolves.toBe(realpathSync(filePath));
  });
});
