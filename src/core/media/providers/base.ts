import type {
  ImageGenerationInput,
  ImageGenerationResult,
  Modality,
  ProviderId,
  ProviderStatus,
  SpeechInput,
  SpeechResult,
  TranscriptionInput,
  TranscriptionResult,
} from "../../types.js";

export interface SpeechToTextProvider {
  readonly id: ProviderId;
  getStatus(modality: Modality): Promise<ProviderStatus>;
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>;
}

export interface TextToSpeechProvider {
  readonly id: ProviderId;
  getStatus(modality: Modality): Promise<ProviderStatus>;
  speak(input: SpeechInput): Promise<SpeechResult>;
}

export interface ImageGenerationProvider {
  readonly id: ProviderId;
  getStatus(modality: Modality): Promise<ProviderStatus>;
  generateImage(input: ImageGenerationInput): Promise<ImageGenerationResult>;
}
