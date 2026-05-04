import { BridgeConfig, BridgeEnv, normalizeProviderChain } from "../config.js";
import type { ImageGenerationInput, ImageGenerationResult, Modality, ProviderId, ProviderStatus, SpeechInput, SpeechResult, TranscriptionInput, TranscriptionResult } from "../types.js";
import { BridgeState } from "../state.js";
import { ElevenLabsProvider } from "./providers/elevenlabs-provider.js";
import { GoogleImageProvider } from "./providers/google-provider.js";
import { OpenAIProvider } from "./providers/openai-provider.js";
import type { ImageGenerationProvider, SpeechToTextProvider, TextToSpeechProvider } from "./providers/base.js";

const ASR_PROVIDER_TIMEOUT_MS = 45_000;
const TTS_PROVIDER_TIMEOUT_MS = 60_000;
const IMAGE_PROVIDER_TIMEOUT_MS = 120_000;

function providerTimeoutError(modalityLabel: string, providerId: ProviderId, timeoutMs: number): Error {
  return new Error(`${modalityLabel} provider ${providerId} timed out after ${Math.round(timeoutMs / 1000)}s.`);
}

async function withProviderTimeout<T>(
  promise: Promise<T>,
  modalityLabel: string,
  providerId: ProviderId,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(providerTimeoutError(modalityLabel, providerId, timeoutMs));
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export class MediaRegistry {
  private readonly asrProviders: Partial<Record<ProviderId, SpeechToTextProvider>>;
  private readonly ttsProviders: Partial<Record<ProviderId, TextToSpeechProvider>>;
  private readonly imageProviders: Partial<Record<ProviderId, ImageGenerationProvider>>;

  constructor(
    private readonly config: BridgeConfig,
    private readonly env: BridgeEnv,
    private readonly state: BridgeState,
  ) {
    const openai = new OpenAIProvider(config, env);
    const elevenlabs = new ElevenLabsProvider(config, env);
    const google = new GoogleImageProvider(config, env);
    this.asrProviders = {
      openai,
    };
    this.ttsProviders = {
      openai,
      elevenlabs,
    };
    this.imageProviders = {
      openai,
      google,
    };
  }

  getEffectiveChain(modality: Modality): ProviderId[] {
    return normalizeProviderChain(
      this.state.getProviderOverride(modality),
      this.config.providers.defaults,
      this.config.providers.fallbacks,
      modality,
    );
  }

  async getProviderStatuses(): Promise<Record<Modality, ProviderStatus[]>> {
    const entries = async <T extends { getStatus(modality: Modality): Promise<ProviderStatus> }>(
      modality: Modality,
      providers: Partial<Record<ProviderId, T>>,
    ) => Promise.all(Object.values(providers).map(provider => provider!.getStatus(modality)));
    return {
      asr: await entries("asr", this.asrProviders),
      tts: await entries("tts", this.ttsProviders),
      image_generation: await entries("image_generation", this.imageProviders),
    };
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    const chain = input.providerId ? [input.providerId] : this.getEffectiveChain("asr");
    const errors: string[] = [];
    for (const providerId of chain) {
      const provider = this.asrProviders[providerId];
      if (!provider) {
        continue;
      }
      try {
        return await withProviderTimeout(
          provider.transcribe(input),
          "ASR",
          providerId,
          ASR_PROVIDER_TIMEOUT_MS,
        );
      } catch (error) {
        errors.push(`${providerId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`No ASR provider succeeded. ${errors.join(" | ")}`);
  }

  async speak(input: SpeechInput): Promise<SpeechResult> {
    const chain = input.providerId ? [input.providerId] : this.getEffectiveChain("tts");
    const errors: string[] = [];
    for (const providerId of chain) {
      const provider = this.ttsProviders[providerId];
      if (!provider) {
        continue;
      }
      try {
        return await withProviderTimeout(
          provider.speak(input),
          "TTS",
          providerId,
          TTS_PROVIDER_TIMEOUT_MS,
        );
      } catch (error) {
        errors.push(`${providerId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`No TTS provider succeeded. ${errors.join(" | ")}`);
  }

  async generateImage(input: ImageGenerationInput): Promise<ImageGenerationResult> {
    const chain = input.providerId ? [input.providerId] : this.getEffectiveChain("image_generation");
    const errors: string[] = [];
    for (const providerId of chain) {
      const provider = this.imageProviders[providerId];
      if (!provider) {
        continue;
      }
      try {
        return await withProviderTimeout(
          provider.generateImage(input),
          "Image generation",
          providerId,
          IMAGE_PROVIDER_TIMEOUT_MS,
        );
      } catch (error) {
        errors.push(`${providerId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`No image provider succeeded. ${errors.join(" | ")}`);
  }
}
