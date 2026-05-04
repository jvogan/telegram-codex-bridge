import { describe, expect, test, vi } from "vitest";

import { deliverDocumentArtifacts } from "../src/core/telegram/document-delivery.js";
import type { StoredArtifact } from "../src/core/types.js";

const artifact: StoredArtifact = {
  id: "artifact-document-1",
  modality: "document",
  providerId: "bridge",
  source: "automatic",
  path: "/tmp/generated-report.pdf",
  mimeType: "application/pdf",
  fileName: "quarterly-report.pdf",
  createdAt: 1,
  metadata: { taskId: "task-1" },
  deliveredAt: null,
};

describe("deliverDocumentArtifacts", () => {
  test("marks artifacts delivered after sendDocument succeeds and preserves the original file name", async () => {
    const sendDocument = vi.fn(async () => undefined);
    const markDelivered = vi.fn();

    await deliverDocumentArtifacts({
      telegram: { sendDocument },
      chatId: "42",
      artifacts: [artifact],
      markDelivered,
      captionForArtifact: () => "Generated file.",
    });

    expect(sendDocument).toHaveBeenCalledWith("42", "/tmp/generated-report.pdf", "Generated file.", "quarterly-report.pdf");
    expect(markDelivered).toHaveBeenCalledWith("artifact-document-1");
  });

  test("leaves artifacts undelivered when sendDocument fails", async () => {
    const sendDocument = vi.fn(async () => {
      throw new Error("document blocked");
    });
    const markDelivered = vi.fn();
    const markFailed = vi.fn();
    const onDeliveryFailure = vi.fn();

    await expect(deliverDocumentArtifacts({
      telegram: { sendDocument },
      chatId: "42",
      artifacts: [artifact],
      markDelivered,
      markFailed,
      onDeliveryFailure,
    })).rejects.toThrow("Failed to deliver 1 document artifact");

    expect(markDelivered).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(markFailed.mock.calls[0]?.[0]).toBe("artifact-document-1");
    expect(onDeliveryFailure).toHaveBeenCalledTimes(1);
  });
});
