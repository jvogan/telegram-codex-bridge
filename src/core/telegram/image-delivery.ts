import type { StoredArtifact } from "../types.js";
import type { TelegramClient } from "./client.js";

export interface DeliverImageArtifactsOptions {
  telegram: Pick<TelegramClient, "sendDocument" | "sendPhoto">;
  chatId: string;
  artifacts: StoredArtifact[];
  markDelivered: (artifactId: string) => void;
  markFailed?: (artifactId: string, error: unknown) => void;
  captionForArtifact?: (artifact: StoredArtifact) => string | undefined;
  onPhotoFallback?: (artifact: StoredArtifact, error: unknown) => void;
  onDeliveryFailure?: (artifact: StoredArtifact, error: unknown) => void;
}

export async function deliverImageArtifacts(options: DeliverImageArtifactsOptions): Promise<string[]> {
  const failures: string[] = [];
  const delivered: string[] = [];
  for (const artifact of options.artifacts) {
    try {
      await options.telegram.sendPhoto(
        options.chatId,
        artifact.path,
        options.captionForArtifact?.(artifact),
      );
      options.markDelivered(artifact.id);
      delivered.push(artifact.id);
      continue;
    } catch (error) {
      options.onPhotoFallback?.(artifact, error);
    }

    try {
      await options.telegram.sendDocument(
        options.chatId,
        artifact.path,
        options.captionForArtifact?.(artifact),
        artifact.fileName,
      );
      options.markDelivered(artifact.id);
      delivered.push(artifact.id);
    } catch (error) {
      failures.push(artifact.id);
      options.markFailed?.(artifact.id, error);
      options.onDeliveryFailure?.(artifact, error);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Failed to deliver ${failures.length} image artifact(s) to Telegram.`);
  }
  return delivered;
}
