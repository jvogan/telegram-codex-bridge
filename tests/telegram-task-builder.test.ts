import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test, vi } from "vitest";

import {
  buildTelegramTask,
  buildTelegramTurnInputs,
  looksLikeImageGenerationRequest,
  MAX_AUDIO_INPUT_BYTES,
  MAX_DOCUMENT_INPUT_BYTES,
  MAX_IMAGE_INPUT_BYTES,
  MAX_VIDEO_INPUT_BYTES,
  shouldCarryForwardFastAsrPreference,
  TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
} from "../src/core/telegram/tasks.js";
import type { TelegramMessage } from "../src/core/telegram/types.js";

describe("telegram task builder", () => {
  test("builds an image task from the highest resolution Telegram photo", () => {
    const message: TelegramMessage = {
      message_id: 17,
      date: 1,
      chat: { id: 42, type: "private" },
      caption: "look at this",
      photo: [
        { file_id: "small", width: 10, height: 10 },
        { file_id: "large", width: 50, height: 50 },
      ],
    };

    const task = buildTelegramTask(99, message, () => true);

    expect(task).toMatchObject({
      updateId: 99,
      chatId: "42",
      messageId: 17,
      kind: "image",
      text: "look at this",
      photoFileId: "large",
      forceSpeak: true,
    });
  });

  test("builds an image task from a Telegram image document", () => {
    const message: TelegramMessage = {
      message_id: 18,
      date: 1,
      chat: { id: 42, type: "private" },
      caption: "inspect this png",
      document: {
        file_id: "doc-image",
        file_name: "diagram.png",
        mime_type: "image/png",
      },
    };

    const task = buildTelegramTask(100, message, () => false);

    expect(task).toMatchObject({
      updateId: 100,
      chatId: "42",
      messageId: 18,
      kind: "image",
      text: "inspect this png",
      photoFileId: "doc-image",
      imageFileName: "diagram.png",
      imageMimeType: "image/png",
      forceSpeak: false,
    });
  });

  test("builds a document task from a non-image Telegram document", () => {
    const message: TelegramMessage = {
      message_id: 19,
      date: 1,
      chat: { id: 42, type: "private" },
      caption: "check this log",
      document: {
        file_id: "doc-log",
        file_name: "server.log",
        mime_type: "text/plain",
      },
    };

    const task = buildTelegramTask(101, message, () => false);

    expect(task).toMatchObject({
      updateId: 101,
      chatId: "42",
      messageId: 19,
      kind: "document",
      text: "check this log",
      documentFileId: "doc-log",
      documentFileName: "server.log",
      documentMimeType: "text/plain",
      forceSpeak: false,
    });
  });

  test("builds a video task from a Telegram video attachment", () => {
    const message: TelegramMessage = {
      message_id: 22,
      date: 1,
      chat: { id: 42, type: "private" },
      caption: "review this clip",
      video: {
        file_id: "video-1",
        file_name: "clip.mp4",
        mime_type: "video/mp4",
        duration: 12,
        file_size: 3_000_000,
      },
    };

    const task = buildTelegramTask(104, message, () => false);

    expect(task).toMatchObject({
      updateId: 104,
      chatId: "42",
      messageId: 22,
      kind: "video",
      text: "review this clip",
      videoFileId: "video-1",
      videoFileName: "clip.mp4",
      videoMimeType: "video/mp4",
      videoDurationSeconds: 12,
      forceSpeak: false,
    });
  });

  test("builds a video task from a Telegram video document", () => {
    const message: TelegramMessage = {
      message_id: 23,
      date: 1,
      chat: { id: 42, type: "private" },
      document: {
        file_id: "doc-video",
        file_name: "clip.mov",
        mime_type: "video/quicktime",
      },
    };

    const task = buildTelegramTask(105, message, () => false);

    expect(task).toMatchObject({
      updateId: 105,
      chatId: "42",
      messageId: 23,
      kind: "video",
      videoFileId: "doc-video",
      videoFileName: "clip.mov",
      videoMimeType: "video/quicktime",
      forceSpeak: false,
    });
  });

  test("builds a video task from a Telegram animation", () => {
    const message: TelegramMessage = {
      message_id: 26,
      date: 1,
      chat: { id: 42, type: "private" },
      animation: {
        file_id: "animation-1",
        file_name: "demo.mp4",
        mime_type: "video/mp4",
        duration: 4,
      },
    };

    const task = buildTelegramTask(108, message, () => false);

    expect(task).toMatchObject({
      updateId: 108,
      chatId: "42",
      messageId: 26,
      kind: "video",
      text: "Please inspect the attached animation.",
      videoFileId: "animation-1",
      videoFileName: "demo.mp4",
      videoMimeType: "video/mp4",
      videoDurationSeconds: 4,
    });
  });

  test("builds a video task from a Telegram video note", () => {
    const message: TelegramMessage = {
      message_id: 27,
      date: 1,
      chat: { id: 42, type: "private" },
      video_note: {
        file_id: "video-note-1",
        duration: 8,
        file_size: 1_000_000,
      },
    };

    const task = buildTelegramTask(109, message, () => false);

    expect(task).toMatchObject({
      updateId: 109,
      chatId: "42",
      messageId: 27,
      kind: "video",
      text: "Please inspect the attached video note.",
      videoFileId: "video-note-1",
      videoMimeType: "video/mp4",
      videoDurationSeconds: 8,
      videoFileSize: 1_000_000,
    });
  });

  test("builds an audio task from a Telegram audio document", () => {
    const message: TelegramMessage = {
      message_id: 28,
      date: 1,
      chat: { id: 42, type: "private" },
      caption: "transcribe this recording",
      document: {
        file_id: "audio-doc-1",
        file_name: "recording.ogg",
        mime_type: "audio/ogg",
      },
    };

    const task = buildTelegramTask(110, message, () => false);

    expect(task).toMatchObject({
      updateId: 110,
      chatId: "42",
      messageId: 28,
      kind: "audio",
      text: "transcribe this recording",
      mediaFileId: "audio-doc-1",
      mediaFileName: "recording.ogg",
      mediaMimeType: "audio/ogg",
    });
  });

  test("builds audio tasks from common audio document extensions", () => {
    for (const fileName of ["session.aiff", "voice.weba"]) {
      const message: TelegramMessage = {
        message_id: 29,
        date: 1,
        chat: { id: 42, type: "private" },
        document: {
          file_id: `audio-${fileName}`,
          file_name: fileName,
          mime_type: "application/octet-stream",
        },
      };

      const task = buildTelegramTask(111, message, () => false);

      expect(task).toMatchObject({
        kind: "audio",
        mediaFileId: `audio-${fileName}`,
        mediaFileName: fileName,
      });
    }
  });

  test("detects a natural-language request for a spoken reply", () => {
    const message: TelegramMessage = {
      message_id: 20,
      date: 1,
      chat: { id: 42, type: "private" },
      text: "Please answer with audio once you're done.",
    };

    const task = buildTelegramTask(102, message, () => false);

    expect(task).toMatchObject({
      kind: "text",
      text: "Please answer with audio once you're done.",
      forceSpeak: true,
    });
  });

  test("detects a natural-language spoken reply request in a caption", () => {
    const message: TelegramMessage = {
      message_id: 21,
      date: 1,
      chat: { id: 42, type: "private" },
      document: {
        file_id: "doc-log",
        file_name: "server.log",
        mime_type: "text/plain",
      },
      caption: "Summarize this and send the answer back as a voice note.",
    };

    const task = buildTelegramTask(103, message, () => false);

    expect(task).toMatchObject({
      kind: "document",
      forceSpeak: true,
    });
  });

  test("detects a natural-language fast ASR request in an audio caption", () => {
    const message: TelegramMessage = {
      message_id: 24,
      date: 1,
      chat: { id: 42, type: "private" },
      audio: {
        file_id: "audio-1",
        file_name: "briefing.m4a",
        mime_type: "audio/mp4",
      },
      caption: "Please use fast ASR and transcribe this quickly.",
    };

    const task = buildTelegramTask(106, message, () => false);

    expect(task).toMatchObject({
      kind: "audio",
      preferFastAsr: true,
    });
  });

  test("uses the carried-forward fast ASR flag for the next media task", () => {
    const message: TelegramMessage = {
      message_id: 25,
      date: 1,
      chat: { id: 42, type: "private" },
      voice: {
        file_id: "voice-1",
        mime_type: "audio/ogg",
      },
      caption: "Please transcribe this.",
    };

    const task = buildTelegramTask(107, message, () => false, () => true);

    expect(task).toMatchObject({
      kind: "voice",
      preferFastAsr: true,
    });
  });

  test("recognizes visual image-generation requests without matching data-model work", () => {
    expect(looksLikeImageGenerationRequest("Generate a highly detailed model of a protein receptor.")).toBe(true);
    expect(looksLikeImageGenerationRequest("Generate a highly detailed and labeled model of telomerase.")).toBe(true);
    expect(looksLikeImageGenerationRequest("Make a model of telomerase.")).toBe(true);
    expect(looksLikeImageGenerationRequest("Create a UI mockup for the dashboard.")).toBe(true);
    expect(looksLikeImageGenerationRequest("Generate a Prisma data model for user accounts.")).toBe(false);
    expect(looksLikeImageGenerationRequest("Generate a data model for a protein API.")).toBe(false);
  });

  test("carries forward relaxed fast ASR preferences from conversational captions", () => {
    expect(shouldCarryForwardFastAsrPreference("Keep it fast for the next audio demo.", { relaxed: true })).toBe(true);
    expect(shouldCarryForwardFastAsrPreference("Keep it fast for the next audio demo.")).toBe(false);
  });

  test("converts an image task into text plus localImage inputs", async () => {
    const editMessageText = vi.fn(async () => undefined);
    const downloadFile = vi.fn(async () => "/tmp/downloaded.jpg");
    const result = await buildTelegramTurnInputs({
      id: "task-image",
      updateId: 1,
      chatId: "42",
      messageId: 17,
      kind: "image",
      text: "inspect it",
      photoFileId: "photo-1",
      createdAt: 1,
    }, 555, {
      telegram: {
        editMessageText,
        downloadFile,
      },
      registry: {
        transcribe: vi.fn(),
      } as any,
      artifacts: {
        writeArtifact: vi.fn(),
      } as any,
      inboundRoot: "/tmp/inbound",
      normalizedRoot: "/tmp/normalized",
    });

    expect(editMessageText).toHaveBeenCalledWith("42", 555, "Working on it.\nDownloading image.");
    expect(downloadFile).toHaveBeenCalledWith("photo-1", "/tmp/inbound/task-image.jpg", {
      maxBytes: MAX_IMAGE_INPUT_BYTES,
      timeoutMs: TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
    });
    expect(result).toEqual([
      { type: "text", text: "inspect it" },
      { type: "localImage", path: "/tmp/inbound/task-image.jpg" },
    ]);
  });

  test("converts a video task into text plus a preview image and transcript", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-bridge-video-"));
    const inboundRoot = join(root, "inbound");
    const normalizedRoot = join(root, "normalized");
    mkdirSync(inboundRoot, { recursive: true });
    mkdirSync(normalizedRoot, { recursive: true });
    const editMessageText = vi.fn(async () => undefined);
    const downloadFile = vi.fn(async (_fileId: string, destinationPath: string) => {
      writeFileSync(destinationPath, "video-bytes");
      return destinationPath;
    });
    const extractVideoFrameImpl = vi.fn(async (_inputPath: string, outputPath: string) => {
      writeFileSync(outputPath, "preview");
      return outputPath;
    });
    const transcodeToWavImpl = vi.fn(async (_inputPath: string, outputPath: string) => {
      writeFileSync(outputPath, "wav");
      return outputPath;
    });
    const transcribe = vi.fn(async () => ({ providerId: "openai", text: "spoken words in the clip" }));
    const writeArtifact = vi.fn(async () => ({ id: "artifact-2", path: "/tmp/artifact.txt" }));

    try {
      const result = await buildTelegramTurnInputs({
        id: "task-video",
        updateId: 1,
        chatId: "42",
        messageId: 17,
        kind: "video",
        text: "review this clip",
        videoFileId: "video-1",
        videoFileName: "clip.mp4",
        videoMimeType: "video/mp4",
        createdAt: 1,
      }, 555, {
        telegram: {
          editMessageText,
          downloadFile,
        },
        registry: {
          transcribe,
        } as any,
        artifacts: {
          writeArtifact,
        } as any,
        inboundRoot,
        normalizedRoot,
        extractVideoFrameImpl,
        transcodeToWavImpl,
      });

      expect(editMessageText).toHaveBeenCalledWith("42", 555, "Working on it.\nDownloading video.");
      expect(downloadFile).toHaveBeenCalledWith("video-1", join(inboundRoot, "task-video.mp4"), {
        maxBytes: MAX_VIDEO_INPUT_BYTES,
        timeoutMs: TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
      });
      expect(extractVideoFrameImpl).toHaveBeenCalled();
      expect(transcodeToWavImpl).toHaveBeenCalled();
      expect(transcribe).toHaveBeenCalled();
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ type: "text" });
      expect(result[1]).toEqual({ type: "localImage", path: join(inboundRoot, "task-video.jpg") });
      expect((result[0] as { text: string }).text).toContain("Transcript:");
      expect((result[0] as { text: string }).text).toContain("The user sent a video with this request: review this clip");
      expect((result[0] as { text: string }).text).toContain("spoken words in the clip");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reuses a staged image path without redownloading", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-bridge-staged-image-"));
    const stagedImagePath = join(root, "staged.jpg");
    writeFileSync(stagedImagePath, "image");
    const editMessageText = vi.fn(async () => undefined);
    const downloadFile = vi.fn(async () => "/tmp/downloaded.jpg");
    try {
      const result = await buildTelegramTurnInputs({
        id: "task-image-staged",
        updateId: 1,
        chatId: "42",
        messageId: 17,
        kind: "image",
        text: "inspect it",
        photoFileId: "photo-1",
        stagedImagePath,
        createdAt: 1,
      }, 555, {
        telegram: {
          editMessageText,
          downloadFile,
        },
        registry: {
          transcribe: vi.fn(),
        } as any,
        artifacts: {
          writeArtifact: vi.fn(),
        } as any,
        inboundRoot: "/tmp/inbound",
        normalizedRoot: "/tmp/normalized",
      });

      expect(editMessageText).not.toHaveBeenCalled();
      expect(downloadFile).not.toHaveBeenCalled();
      expect(result).toEqual([
        { type: "text", text: "inspect it" },
        { type: "localImage", path: stagedImagePath },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("builds text inputs without requiring a placeholder message", async () => {
    const result = await buildTelegramTurnInputs({
      id: "task-text",
      updateId: 1,
      chatId: "42",
      messageId: 17,
      kind: "text",
      text: "hello from telegram",
      createdAt: 1,
    }, null, {
      telegram: {
        editMessageText: vi.fn(async () => undefined),
        downloadFile: vi.fn(async () => "/tmp/ignored"),
      },
      registry: {
        transcribe: vi.fn(),
      } as any,
      artifacts: {
        writeArtifact: vi.fn(),
      } as any,
      inboundRoot: "/tmp/inbound",
      normalizedRoot: "/tmp/normalized",
    });

    expect(result).toEqual([
      { type: "text", text: "hello from telegram" },
    ]);
  });

  test("adds a bridge note when the user asks for an audio reply in natural language", async () => {
    const result = await buildTelegramTurnInputs({
      id: "task-text-audio",
      updateId: 1,
      chatId: "42",
      messageId: 17,
      kind: "text",
      text: "Reply with audio after you finish this summary.",
      forceSpeak: true,
      createdAt: 1,
    }, null, {
      telegram: {
        editMessageText: vi.fn(async () => undefined),
        downloadFile: vi.fn(async () => "/tmp/ignored"),
      },
      registry: {
        transcribe: vi.fn(),
      } as any,
      artifacts: {
        writeArtifact: vi.fn(),
      } as any,
      inboundRoot: "/tmp/inbound",
      normalizedRoot: "/tmp/normalized",
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "text" });
    expect((result[0] as { text: string }).text).toContain("Bridge note");
    expect((result[0] as { text: string }).text).toContain("voice reply automatically");
    expect((result[0] as { text: string }).text).toContain("Reply with audio after you finish this summary.");
  });

  test("adds a bridge note for natural-language image generation requests", async () => {
    const result = await buildTelegramTurnInputs({
      id: "task-text-image",
      updateId: 1,
      chatId: "42",
      messageId: 17,
      kind: "text",
      text: "Make me an image of a fox in a rainstorm.",
      forceSpeak: false,
      createdAt: 1,
    }, null, {
      telegram: {
        editMessageText: vi.fn(async () => undefined),
        downloadFile: vi.fn(async () => "/tmp/ignored"),
      },
      registry: {
        transcribe: vi.fn(),
      } as any,
      artifacts: {
        writeArtifact: vi.fn(),
      } as any,
      inboundRoot: "/tmp/inbound",
      normalizedRoot: "/tmp/normalized",
    });

    expect(result).toHaveLength(1);
    expect((result[0] as { text: string }).text).toContain("image-generation tool");
    expect((result[0] as { text: string }).text).toContain("Make me an image of a fox in a rainstorm.");
  });

  test("adds bound-session context without dropping other bridge notes", async () => {
    const result = await buildTelegramTurnInputs({
      id: "task-bound-session",
      updateId: 1,
      chatId: "42",
      messageId: 17,
      kind: "text",
      text: "Tell the bound Codex session to reply here with audio.",
      forceSpeak: true,
      createdAt: 1,
    }, null, {
      telegram: {
        editMessageText: vi.fn(async () => undefined),
        downloadFile: vi.fn(async () => "/tmp/ignored"),
      },
      registry: {
        transcribe: vi.fn(),
      } as any,
      artifacts: {
        writeArtifact: vi.fn(),
      } as any,
      inboundRoot: "/tmp/inbound",
      normalizedRoot: "/tmp/normalized",
    });

    expect(result).toHaveLength(1);
    const text = (result[0] as { text: string }).text;
    expect(text).toContain("voice reply automatically");
    expect(text).toContain("currently bound Codex session");
    expect(text).toContain("Tell the bound Codex session to reply here with audio.");
  });

  test("converts a document task into a Codex-readable text prompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-bridge-doc-"));
    const inboundRoot = join(root, "inbound");
    const normalizedRoot = join(root, "normalized");
    mkdirSync(inboundRoot, { recursive: true });
    mkdirSync(normalizedRoot, { recursive: true });
    const editMessageText = vi.fn(async () => undefined);
    const downloadFile = vi.fn(async (_fileId: string, destinationPath: string) => {
      writeFileSync(destinationPath, "line one\nline two\nline three\n");
      return destinationPath;
    });

    try {
      const result = await buildTelegramTurnInputs({
        id: "task-document",
        updateId: 1,
        chatId: "42",
        messageId: 17,
        kind: "document",
        text: "check this log",
        documentFileId: "doc-1",
        documentFileName: "server.log",
        documentMimeType: "text/plain",
        createdAt: 1,
      }, 555, {
        telegram: {
          editMessageText,
          downloadFile,
        },
        registry: {
          transcribe: vi.fn(),
        } as any,
        artifacts: {
          writeArtifact: vi.fn(),
        } as any,
        inboundRoot,
        normalizedRoot,
      });

      expect(editMessageText).toHaveBeenCalledWith("42", 555, "Working on it.\nDownloading file.");
      expect(downloadFile).toHaveBeenCalledWith("doc-1", join(inboundRoot, "task-document.log"), {
        maxBytes: MAX_DOCUMENT_INPUT_BYTES,
        timeoutMs: TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
      });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ type: "text" });
      expect((result[0] as { text: string }).text).toContain("The user sent a document with this request: check this log");
      expect((result[0] as { text: string }).text).toContain("File name: server.log");
      expect((result[0] as { text: string }).text).toContain("line one");
      expect((result[0] as { text: string }).text).not.toContain("Downloaded path:");
      expect((result[0] as { text: string }).text).not.toContain(join(inboundRoot, "task-document.log"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses the fast ASR path when the user asks for it", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-bridge-fast-asr-"));
    const inboundRoot = join(root, "inbound");
    const normalizedRoot = join(root, "normalized");
    mkdirSync(inboundRoot, { recursive: true });
    mkdirSync(normalizedRoot, { recursive: true });
    const editMessageText = vi.fn(async () => undefined);
    const downloadFile = vi.fn(async (_fileId: string, destinationPath: string) => {
      writeFileSync(destinationPath, "audio");
      return destinationPath;
    });
    const transcribe = vi.fn(async (input: { filePath: string; providerId?: string; model?: string }) => ({
      providerId: input.providerId === "openai" ? "openai" : "test-provider",
      text: "transcript",
    }));
    const writeArtifact = vi.fn(async () => ({ id: "artifact-fast-asr", path: "/tmp/artifact.txt" }));

    try {
      await buildTelegramTurnInputs({
        id: "task-fast-audio",
        updateId: 1,
        chatId: "42",
        messageId: 17,
        kind: "audio",
        text: "Please transcribe this quickly.",
        mediaFileId: "audio-1",
        mediaFileName: "meeting.m4a",
        preferFastAsr: true,
        createdAt: 1,
      }, 555, {
        telegram: {
          editMessageText,
          downloadFile,
        },
        registry: {
          transcribe,
        } as any,
        artifacts: {
          writeArtifact,
        } as any,
        inboundRoot,
        normalizedRoot,
        transcodeToWavImpl: vi.fn(async () => join(normalizedRoot, "task-fast-audio.wav")),
      });

      expect(editMessageText).toHaveBeenCalledWith("42", 555, "Working on it.\nTranscribing audio quickly.");
      expect(transcribe).toHaveBeenCalledWith({
        filePath: join(normalizedRoot, "task-fast-audio.wav"),
        providerId: "openai",
        model: "gpt-4o-mini-transcribe",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("best-effort extracts non-plain-text documents before sending them into Codex", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-bridge-rich-doc-"));
    const inboundRoot = join(root, "inbound");
    const normalizedRoot = join(root, "normalized");
    mkdirSync(inboundRoot, { recursive: true });
    mkdirSync(normalizedRoot, { recursive: true });
    const editMessageText = vi.fn(async () => undefined);
    const downloadFile = vi.fn(async (_fileId: string, destinationPath: string) => {
      writeFileSync(destinationPath, "%PDF-stub");
      return destinationPath;
    });
    const extractDocumentTextImpl = vi.fn(async () => ({
      text: "Quarterly revenue increased 12 percent.\nAction items:\n- Hire two engineers",
      method: "pdftotext",
    }));

    try {
      const result = await buildTelegramTurnInputs({
        id: "task-pdf",
        updateId: 1,
        chatId: "42",
        messageId: 17,
        kind: "document",
        text: "Summarize this PDF",
        documentFileId: "doc-pdf",
        documentFileName: "q1-report.pdf",
        documentMimeType: "application/pdf",
        createdAt: 1,
      }, 555, {
        telegram: {
          editMessageText,
          downloadFile,
        },
        registry: {
          transcribe: vi.fn(),
        } as any,
        artifacts: {
          writeArtifact: vi.fn(),
        } as any,
        inboundRoot,
        normalizedRoot,
        extractDocumentTextImpl,
      });

      expect(extractDocumentTextImpl).toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect((result[0] as { text: string }).text).toContain("Extraction method: pdftotext");
      expect((result[0] as { text: string }).text).toContain("Quarterly revenue increased 12 percent.");
      expect((result[0] as { text: string }).text).toContain("Summarize this PDF");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects oversized document attachments before downloading them", async () => {
    const editMessageText = vi.fn(async () => undefined);
    const downloadFile = vi.fn(async () => "/tmp/ignored");

    await expect(buildTelegramTurnInputs({
      id: "task-large-document",
      updateId: 1,
      chatId: "42",
      messageId: 17,
      kind: "document",
      text: "inspect this report",
      documentFileId: "doc-oversized",
      documentFileName: "report.pdf",
      documentMimeType: "application/pdf",
      documentFileSize: 16 * 1024 * 1024,
      createdAt: 1,
    }, 555, {
      telegram: {
        editMessageText,
        downloadFile,
      },
      registry: {
        transcribe: vi.fn(),
      } as any,
      artifacts: {
        writeArtifact: vi.fn(),
      } as any,
      inboundRoot: "/tmp/inbound",
      normalizedRoot: "/tmp/normalized",
    })).rejects.toThrow("Document attachment is too large");

    expect(editMessageText).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
  });

  test("rejects overly long audio attachments before transcription starts", async () => {
    const editMessageText = vi.fn(async () => undefined);
    const downloadFile = vi.fn(async () => "/tmp/ignored");
    const transcribe = vi.fn();

    await expect(buildTelegramTurnInputs({
      id: "task-long-audio",
      updateId: 1,
      chatId: "42",
      messageId: 17,
      kind: "audio",
      text: "please summarize this",
      mediaFileId: "audio-1",
      mediaFileName: "meeting.m4a",
      mediaMimeType: "audio/mp4",
      mediaDurationSeconds: 601,
      createdAt: 1,
    }, 555, {
      telegram: {
        editMessageText,
        downloadFile,
      },
      registry: {
        transcribe,
      } as any,
      artifacts: {
        writeArtifact: vi.fn(),
      } as any,
      inboundRoot: "/tmp/inbound",
      normalizedRoot: "/tmp/normalized",
    })).rejects.toThrow("Audio attachment is too long");

    expect(editMessageText).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
  });

  test("downloads audio attachments with size and timeout guards", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-bridge-audio-"));
    const inboundRoot = join(root, "inbound");
    const normalizedRoot = join(root, "normalized");
    mkdirSync(inboundRoot, { recursive: true });
    mkdirSync(normalizedRoot, { recursive: true });
    const editMessageText = vi.fn(async () => undefined);
    const downloadFile = vi.fn(async (_fileId: string, destinationPath: string) => {
      writeFileSync(destinationPath, "audio");
      return destinationPath;
    });
    const transcribe = vi.fn(async () => ({ providerId: "openai", text: "transcript" }));
    const writeArtifact = vi.fn(async () => ({ id: "artifact-1", path: "/tmp/artifact.txt" }));

    try {
      await buildTelegramTurnInputs({
        id: "task-audio",
        updateId: 1,
        chatId: "42",
        messageId: 17,
        kind: "audio",
        text: "summarize this",
        mediaFileId: "audio-1",
        mediaFileName: "meeting.m4a",
        createdAt: 1,
      }, 555, {
        telegram: {
          editMessageText,
          downloadFile,
        },
        registry: {
          transcribe,
        } as any,
        artifacts: {
          writeArtifact,
        } as any,
        inboundRoot,
        normalizedRoot,
        transcodeToWavImpl: vi.fn(async () => join(normalizedRoot, "task-audio.wav")),
      });

      expect(downloadFile).toHaveBeenCalledWith("audio-1", join(inboundRoot, "task-audio.m4a"), {
        maxBytes: MAX_AUDIO_INPUT_BYTES,
        timeoutMs: TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses audio MIME type when choosing a download extension", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-codex-bridge-audio-mime-"));
    const inboundRoot = join(root, "inbound");
    const normalizedRoot = join(root, "normalized");
    mkdirSync(inboundRoot, { recursive: true });
    mkdirSync(normalizedRoot, { recursive: true });
    const downloadFile = vi.fn(async (_fileId: string, destinationPath: string) => {
      writeFileSync(destinationPath, "audio");
      return destinationPath;
    });

    try {
      await buildTelegramTurnInputs({
        id: "task-audio-mime",
        updateId: 1,
        chatId: "42",
        messageId: 17,
        kind: "audio",
        text: "summarize this",
        mediaFileId: "audio-1",
        mediaMimeType: "audio/mp4",
        createdAt: 1,
      }, 555, {
        telegram: {
          editMessageText: vi.fn(async () => undefined),
          downloadFile,
        },
        registry: {
          transcribe: vi.fn(async () => ({ providerId: "openai", text: "transcript" })),
        } as any,
        artifacts: {
          writeArtifact: vi.fn(async () => ({ id: "artifact-1", path: "/tmp/artifact.txt" })),
        } as any,
        inboundRoot,
        normalizedRoot,
        transcodeToWavImpl: vi.fn(async () => join(normalizedRoot, "task-audio-mime.wav")),
      });

      expect(downloadFile).toHaveBeenCalledWith("audio-1", join(inboundRoot, "task-audio-mime.m4a"), {
        maxBytes: MAX_AUDIO_INPUT_BYTES,
        timeoutMs: TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
