import { readFile } from "node:fs/promises";

import OpenAI from "openai";

import type { BridgeConfig, BridgeEnv } from "../../config.js";
import { missingOpenAIProviderMessage } from "../../onboarding-messages.js";
import type {
  ImageGenerationInput,
  ImageGenerationResult,
  Modality,
  ProviderStatus,
  SpeechInput,
  SpeechResult,
  TranscriptionInput,
  TranscriptionResult,
} from "../../types.js";
import type { ImageGenerationProvider, SpeechToTextProvider, TextToSpeechProvider } from "./base.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;
}

export class OpenAIProvider implements SpeechToTextProvider, TextToSpeechProvider, ImageGenerationProvider {
  readonly id = "openai" as const;
  private readonly client: OpenAI | null;

  constructor(
    private readonly config: BridgeConfig,
    private readonly env: BridgeEnv,
  ) {
    this.client = env.openaiApiKey ? new OpenAI({ apiKey: env.openaiApiKey }) : null;
  }

  async getStatus(modality: Modality): Promise<ProviderStatus> {
    const enabled = this.config.providers.openai.enabled;
    return {
      id: this.id,
      modality,
      available: this.client !== null && enabled,
      reachable: this.client !== null && enabled,
      detail: !enabled
        ? "disabled in config"
        : this.client
          ? "API key present"
          : "OPENAI_API_KEY missing (add it to .env to enable OpenAI-backed media or /call)",
    };
  }

  private requireClient(): OpenAI {
    if (!this.client) {
      throw new Error(missingOpenAIProviderMessage());
    }
    return this.client;
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    const client = this.requireClient();
    const fileBuffer = await readFile(input.filePath);
    const transcription = await client.audio.transcriptions.create({
      file: await OpenAI.toFile(fileBuffer, "audio.wav"),
      model: input.model || this.config.providers.openai.asr_model,
      response_format: "text",
      ...(input.prompt ? { prompt: input.prompt } : {}),
      ...(input.language ? { language: input.language } : {}),
    } as never);
    const text = typeof transcription === "string"
      ? transcription
      : "text" in transcription && typeof transcription.text === "string"
        ? transcription.text
        : String(transcription);
    const raw = asRecord(transcription);
    return {
      providerId: this.id,
      text,
      ...(raw ? { raw } : {}),
    };
  }

  async speak(input: SpeechInput): Promise<SpeechResult> {
    const client = this.requireClient();
    const response = await client.audio.speech.create({
      model: input.model || this.config.providers.openai.tts_model,
      voice: input.voice || this.config.providers.openai.tts_voice,
      input: input.text,
      ...(input.instructions ? { instructions: input.instructions } : {}),
      ...(input.responseFormat ? { response_format: input.responseFormat } : {}),
    } as never);
    const arrayBuffer = await response.arrayBuffer();
    const format = input.responseFormat || this.config.providers.openai.tts_response_format;
    return {
      providerId: this.id,
      buffer: Buffer.from(arrayBuffer),
      mimeType: format === "mp3" ? "audio/mpeg" : format === "ogg" ? "audio/ogg" : "audio/wav",
      fileExtension: format === "mp3" ? "mp3" : format === "ogg" ? "ogg" : "wav",
    };
  }

  async generateImage(input: ImageGenerationInput): Promise<ImageGenerationResult> {
    const client = this.requireClient();
    const response = await client.images.generate({
      model: input.model || this.config.providers.openai.image_model,
      prompt: input.prompt,
      size: input.size || this.config.providers.openai.image_size,
    } as never);
    const first = (response as unknown as { data?: Array<{ b64_json?: string; revised_prompt?: string | null }> }).data?.[0];
    const encoded = first?.b64_json;
    if (!encoded) {
      throw new Error("OpenAI image generation returned no image payload.");
    }
    return {
      providerId: this.id,
      buffer: Buffer.from(encoded, "base64"),
      mimeType: "image/png",
      fileExtension: "png",
      revisedPrompt: first?.revised_prompt ?? null,
      raw: response as unknown as Record<string, unknown>,
    };
  }
}
