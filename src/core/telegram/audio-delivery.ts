import { join } from "node:path";

import { transcodeToTelegramVoice } from "../util/ffmpeg.js";
import type { StoredArtifact } from "../types.js";
import type { TelegramClient } from "./client.js";

export interface DeliverAudioArtifactsOptions {
  telegram: Pick<TelegramClient, "sendDocument" | "sendVoice">;
  chatId: string;
  artifacts: StoredArtifact[];
  outputRoot: string;
  markDelivered: (artifactId: string) => void;
  markFailed?: (artifactId: string, error: unknown) => void;
  captionForArtifact?: (artifact: StoredArtifact) => string | undefined;
  onVoiceFallback?: (artifact: StoredArtifact, error: unknown) => void;
  onDeliveryFailure?: (artifact: StoredArtifact, error: unknown) => void;
}

export async function deliverAudioArtifacts(options: DeliverAudioArtifactsOptions): Promise<void> {
  const failures: string[] = [];
  for (const artifact of options.artifacts) {
    const voicePath = join(options.outputRoot, `${artifact.id}.ogg`);
    try {
      await transcodeToTelegramVoice(artifact.path, voicePath);
      await options.telegram.sendVoice(
        options.chatId,
        voicePath,
        options.captionForArtifact?.(artifact),
      );
      options.markDelivered(artifact.id);
      continue;
    } catch (error) {
      options.onVoiceFallback?.(artifact, error);
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
    throw new Error(`Failed to deliver ${failures.length} audio artifact(s) to Telegram.`);
  }
}
