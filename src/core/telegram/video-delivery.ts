import type { StoredArtifact } from "../types.js";
import type { TelegramClient } from "./client.js";

export interface DeliverVideoArtifactsOptions {
  telegram: Pick<TelegramClient, "sendDocument" | "sendVideo">;
  chatId: string;
  artifacts: StoredArtifact[];
  markDelivered: (artifactId: string) => void;
  markFailed?: (artifactId: string, error: unknown) => void;
  captionForArtifact?: (artifact: StoredArtifact) => string | undefined;
  onVideoFallback?: (artifact: StoredArtifact, error: unknown) => void;
  onDeliveryFailure?: (artifact: StoredArtifact, error: unknown) => void;
}

export async function deliverVideoArtifacts(options: DeliverVideoArtifactsOptions): Promise<void> {
  const failures: string[] = [];
  for (const artifact of options.artifacts) {
    try {
      await options.telegram.sendVideo(
        options.chatId,
        artifact.path,
        options.captionForArtifact?.(artifact),
        artifact.fileName,
      );
      options.markDelivered(artifact.id);
      continue;
    } catch (error) {
      options.onVideoFallback?.(artifact, error);
    }

    try {
      await options.telegram.sendDocument(
        options.chatId,
        artifact.path,
        options.captionForArtifact?.(artifact),
        artifact.fileName,
      );
      options.markDelivered(artifact.id);
    } catch (error) {
      failures.push(artifact.id);
      options.markFailed?.(artifact.id, error);
      options.onDeliveryFailure?.(artifact, error);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Failed to deliver ${failures.length} video artifact(s) to Telegram.`);
  }
}
