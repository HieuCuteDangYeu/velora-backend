export type TranscriptionAudioFormat = 'wav' | 'flac' | 'opus';

// Opus is stored in an Ogg container; Groq accepts it as .ogg.
export const TRANSCRIPTION_AUDIO_EXTENSION: Record<
  TranscriptionAudioFormat,
  string
> = { wav: 'wav', flac: 'flac', opus: 'ogg' };

export interface TranscriptionAudioArtifact {
  key: string;
  startMs: number;
  endMs: number;
  overlapBeforeMs: number;
  checksum: string;
  byteLength: number;
}

export interface TranscriptionAudioManifest {
  reelId: string;
  mediaAttemptId: string;
  totalDurationMs: number;
  format: TranscriptionAudioFormat;
  artifacts: TranscriptionAudioArtifact[];
  version: 1;
}
