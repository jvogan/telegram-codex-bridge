import { GoogleGenAI } from "@google/genai";

import type { BridgeConfig, BridgeEnv } from "../../config.js";
import type { ImageGenerationInput, ImageGenerationResult, Modality, ProviderStatus } from "../../types.js";
import type { ImageGenerationProvider } from "./base.js";

export class GoogleImageProvider implements ImageGenerationProvider {
  readonly id = "google" as const;
  private readonly client: GoogleGenAI | null;

  constructor(
    private readonly config: BridgeConfig,
    private readonly env: BridgeEnv,
  ) {
    this.client = env.googleGenAiApiKey ? new GoogleGenAI({ apiKey: env.googleGenAiApiKey }) : null;
  }

  async getStatus(modality: Modality): Promise<ProviderStatus> {
    return {
      id: this.id,
      modality,
      available: this.client !== null && this.config.providers.google.enabled,
      reachable: this.client !== null && this.config.providers.google.enabled,
      detail: !this.config.providers.google.enabled
        ? "disabled in config"
        : this.client
          ? "API key present"
          : "GOOGLE_GENAI_API_KEY missing",
    };
  }

  async generateImage(input: ImageGenerationInput): Promise<ImageGenerationResult> {
    if (!this.client) {
      throw new Error("GOOGLE_GENAI_API_KEY is required for the Google provider.");
    }
    const response = await this.client.models.generateImages({
      model: input.model || this.config.providers.google.image_model,
      prompt: input.prompt,
      config: {
        numberOfImages: 1,
        aspectRatio: input.aspectRatio || this.config.providers.google.image_aspect_ratio,
      },
    } as never);
    const generatedImages = (response as unknown as {
      generatedImages?: Array<{ image?: { imageBytes?: string; mimeType?: string } }>;
    }).generatedImages;
    const first = generatedImages?.[0]?.image;
    const bytes = first?.imageBytes;
    if (!bytes) {
      throw new Error("Google image generation returned no image bytes.");
    }
    const mimeType = first?.mimeType ?? "image/png";
    return {
      providerId: this.id,
      buffer: Buffer.from(bytes, "base64"),
      mimeType,
      fileExtension: mimeType.includes("jpeg") ? "jpg" : "png",
      raw: response as unknown as Record<string, unknown>,
    };
  }
}
