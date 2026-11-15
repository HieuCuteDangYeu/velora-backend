import { TranscriptionResult } from '@common/ai/interfaces/transcription-result.interface';

export interface TranscriptionOptions {
  initialPrompt?: string;
  // File name with the real extension, so the provider detects the audio format.
  fileName?: string;
}

export interface ITranscriptionService {
  transcribeAudio(
    audioBuffer: Buffer,
    options?: TranscriptionOptions,
  ): Promise<TranscriptionResult>;
}
