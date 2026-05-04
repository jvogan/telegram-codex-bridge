import { describe, expect, test, vi } from "vitest";

import { deliverVideoArtifacts } from "../src/core/telegram/video-delivery.js";
import type { StoredArtifact } from "../src/core/types.js";

const artifact: StoredArtifact = {
  id: "artifact-video-1",
  modality: "video",
  providerId: "bridge",
  source: "automatic",
  path: "/tmp/demo.mp4",
  mimeType: "video/mp4",
  fileName: "demo.mp4",
  createdAt: 1,
  metadata: { prompt: "example" },
  deliveredAt: null,
};

describe("deliverVideoArtifacts", () => {
  test("marks artifacts delivered after sendVideo succeeds", async () => {
    const sendVideo = vi.fn(async () => undefined);
    const sendDocument = vi.fn(async () => undefined);
    const markDelivered = vi.fn();

    await deliverVideoArtifacts({
      telegram: { sendVideo, sendDocument },
      chatId: "42",
      artifacts: [artifact],
      markDelivered,
      captionForArtifact: () => "Generated video.",
    });

    expect(sendVideo).toHaveBeenCalledWith("42", "/tmp/demo.mp4", "Generated video.", "demo.mp4");
    expect(sendDocument).not.toHaveBeenCalled();
    expect(markDelivered).toHaveBeenCalledWith("artifact-video-1");
  });

  test("falls back to sendDocument and preserves the original file name", async () => {
    const sendVideo = vi.fn(async () => {
      throw new Error("video blocked");
    });
    const sendDocument = vi.fn(async () => undefined);
    const markDelivered = vi.fn();

    await deliverVideoArtifacts({
      telegram: { sendVideo, sendDocument },
      chatId: "42",
      artifacts: [artifact],
      markDelivered,
      captionForArtifact: () => "Generated video.",
    });

    expect(sendDocument).toHaveBeenCalledWith("42", "/tmp/demo.mp4", "Generated video.", "demo.mp4");
    expect(markDelivered).toHaveBeenCalledWith("artifact-video-1");
  });

  test("leaves artifacts undelivered when both Telegram upload methods fail", async () => {
    const sendVideo = vi.fn(async () => {
      throw new Error("video blocked");
    });
    const sendDocument = vi.fn(async () => {
      throw new Error("document blocked");
    });
    const markDelivered = vi.fn();
    const markFailed = vi.fn();
    const onDeliveryFailure = vi.fn();

    await expect(deliverVideoArtifacts({
      telegram: { sendVideo, sendDocument },
      chatId: "42",
      artifacts: [artifact],
      markDelivered,
      markFailed,
      onDeliveryFailure,
    })).rejects.toThrow("Failed to deliver 1 video artifact");

    expect(markDelivered).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(markFailed.mock.calls[0]?.[0]).toBe("artifact-video-1");
    expect(onDeliveryFailure).toHaveBeenCalledTimes(1);
  });
});
