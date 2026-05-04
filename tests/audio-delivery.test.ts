import { describe, expect, test, vi } from "vitest";

import { deliverAudioArtifacts } from "../src/core/telegram/audio-delivery.js";
import type { StoredArtifact } from "../src/core/types.js";

vi.mock("../src/core/util/ffmpeg.js", () => ({
  transcodeToTelegramVoice: vi.fn(async () => undefined),
}));

const artifact: StoredArtifact = {
  id: "artifact-audio-1",
  modality: "audio",
  providerId: "openai",
  source: "mcp",
  path: "/tmp/example.wav",
  mimeType: "audio/wav",
  fileName: "example.wav",
  createdAt: 1,
  metadata: { prompt: "example" },
  deliveredAt: null,
};

describe("deliverAudioArtifacts", () => {
  test("marks artifacts delivered after sendVoice succeeds", async () => {
    const sendVoice = vi.fn(async () => undefined);
    const sendDocument = vi.fn(async () => undefined);
    const markDelivered = vi.fn();

    await deliverAudioArtifacts({
      telegram: { sendVoice, sendDocument },
      chatId: "42",
      artifacts: [artifact],
      outputRoot: "/tmp/outbound",
      markDelivered,
      captionForArtifact: () => "Generated audio.",
    });

    expect(sendVoice).toHaveBeenCalledWith("42", "/tmp/outbound/artifact-audio-1.ogg", "Generated audio.");
    expect(sendDocument).not.toHaveBeenCalled();
    expect(markDelivered).toHaveBeenCalledWith("artifact-audio-1");
  });

  test("falls back to sendDocument when sendVoice fails", async () => {
    const sendVoice = vi.fn(async () => {
      throw new Error("voice blocked");
    });
    const sendDocument = vi.fn(async () => undefined);
    const markDelivered = vi.fn();

    await deliverAudioArtifacts({
      telegram: { sendVoice, sendDocument },
      chatId: "42",
      artifacts: [artifact],
      outputRoot: "/tmp/outbound",
      markDelivered,
    });

    expect(sendDocument).toHaveBeenCalledWith("42", "/tmp/example.wav", undefined, "example.wav");
    expect(markDelivered).toHaveBeenCalledWith("artifact-audio-1");
  });

  test("leaves artifacts undelivered when both Telegram upload methods fail", async () => {
    const sendVoice = vi.fn(async () => {
      throw new Error("voice blocked");
    });
    const sendDocument = vi.fn(async () => {
      throw new Error("document blocked");
    });
    const markDelivered = vi.fn();
    const markFailed = vi.fn();
    const onDeliveryFailure = vi.fn();

    await expect(deliverAudioArtifacts({
      telegram: { sendVoice, sendDocument },
      chatId: "42",
      artifacts: [artifact],
      outputRoot: "/tmp/outbound",
      markDelivered,
      markFailed,
      onDeliveryFailure,
    })).rejects.toThrow("Failed to deliver 1 audio artifact");

    expect(markDelivered).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(markFailed.mock.calls[0]?.[0]).toBe("artifact-audio-1");
    expect(onDeliveryFailure).toHaveBeenCalledTimes(1);
  });
});
