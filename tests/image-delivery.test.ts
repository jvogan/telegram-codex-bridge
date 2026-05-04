import { describe, expect, test, vi } from "vitest";

import { deliverImageArtifacts } from "../src/core/telegram/image-delivery.js";
import type { StoredArtifact } from "../src/core/types.js";

const artifact: StoredArtifact = {
  id: "artifact-1",
  modality: "image",
  providerId: "openai",
  source: "telegram",
  path: "/tmp/example.png",
  mimeType: "image/png",
  fileName: "example.png",
  createdAt: 1,
  metadata: { prompt: "example" },
  deliveredAt: null,
};

describe("deliverImageArtifacts", () => {
  test("marks artifacts delivered after sendPhoto succeeds", async () => {
    const sendPhoto = vi.fn(async () => undefined);
    const sendDocument = vi.fn(async () => undefined);
    const markDelivered = vi.fn();

    const delivered = await deliverImageArtifacts({
      telegram: { sendPhoto, sendDocument },
      chatId: "42",
      artifacts: [artifact],
      markDelivered,
      captionForArtifact: () => "Generated image.",
    });

    expect(sendPhoto).toHaveBeenCalledWith("42", "/tmp/example.png", "Generated image.");
    expect(sendDocument).not.toHaveBeenCalled();
    expect(markDelivered).toHaveBeenCalledWith("artifact-1");
    expect(delivered).toEqual(["artifact-1"]);
  });

  test("falls back to sendDocument when sendPhoto fails", async () => {
    const sendPhoto = vi.fn(async () => {
      throw new Error("photo blocked");
    });
    const sendDocument = vi.fn(async () => undefined);
    const markDelivered = vi.fn();

    const delivered = await deliverImageArtifacts({
      telegram: { sendPhoto, sendDocument },
      chatId: "42",
      artifacts: [artifact],
      markDelivered,
    });

    expect(sendDocument).toHaveBeenCalledWith("42", "/tmp/example.png", undefined, "example.png");
    expect(markDelivered).toHaveBeenCalledWith("artifact-1");
    expect(delivered).toEqual(["artifact-1"]);
  });

  test("leaves artifacts undelivered when both Telegram upload methods fail", async () => {
    const sendPhoto = vi.fn(async () => {
      throw new Error("photo blocked");
    });
    const sendDocument = vi.fn(async () => {
      throw new Error("document blocked");
    });
    const markDelivered = vi.fn();
    const markFailed = vi.fn();
    const onDeliveryFailure = vi.fn();

    await expect(deliverImageArtifacts({
      telegram: { sendPhoto, sendDocument },
      chatId: "42",
      artifacts: [artifact],
      markDelivered,
      markFailed,
      onDeliveryFailure,
    })).rejects.toThrow("Failed to deliver 1 image artifact");

    expect(markDelivered).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith("artifact-1", expect.any(Error));
    expect(onDeliveryFailure).toHaveBeenCalledTimes(1);
  });
});
