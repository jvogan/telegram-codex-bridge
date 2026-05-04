import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import type { TextToSpeechConvertRequestOutputFormat } from "@elevenlabs/elevenlabs-js/api/resources/textToSpeech/types/TextToSpeechConvertRequestOutputFormat.js";

import type { BridgeConfig, BridgeEnv } from "../../config.js";
import type { Modality, ProviderStatus, SpeechInput, SpeechResult } from "../../types.js";
import type { TextToSpeechProvider } from "./base.js";

export class ElevenLabsProvider implements TextToSpeechProvider {
  readonly id = "elevenlabs" as const;
  private readonly client: ElevenLabsClient | null;

  constructor(
    private readonly config: BridgeConfig,
    private readonly env: BridgeEnv,
  ) {
    this.client = env.elevenlabsApiKey ? new ElevenLabsClient({ apiKey: env.elevenlabsApiKey }) : null;
  }

  async getStatus(modality: Modality): Promise<ProviderStatus> {
    return {
      id: this.id,
      modality,
      available: this.client !== null && this.config.providers.elevenlabs.enabled,
      reachable: this.client !== null && this.config.providers.elevenlabs.enabled,
      detail: !this.config.providers.elevenlabs.enabled
        ? "disabled in config"
        : this.client
          ? "API key present"
          : "ELEVENLABS_API_KEY missing",
    };
  }

  async speak(input: SpeechInput): Promise<SpeechResult> {
    if (!this.client) {
      throw new Error("ELEVENLABS_API_KEY is required for the ElevenLabs provider.");
    }
    const voiceId = input.voice || this.config.providers.elevenlabs.tts_voice_id;
    if (!voiceId) {
      throw new Error("A voice ID is required for the ElevenLabs provider.");
    }
    const stream = await this.client.textToSpeech.convert(voiceId, {
      text: input.text,
      modelId: input.model || this.config.providers.elevenlabs.tts_model,
      outputFormat: this.config.providers.elevenlabs.tts_output_format as TextToSpeechConvertRequestOutputFormat,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    return {
      providerId: this.id,
      buffer: Buffer.concat(chunks),
      mimeType: "audio/mpeg",
      fileExtension: "mp3",
    };
  }
}
