import type { TranscriptionAudioManifest } from '@common/processing/interfaces/transcription-audio-manifest.interface';
import type { VisualFrameManifest } from '@common/processing/interfaces/visual-frame-manifest.interface';

export interface IArtifactStorage {
  getTranscriptionAudioManifest(
    key: string,
  ): Promise<TranscriptionAudioManifest>;
  getVisualFrameManifest(key: string): Promise<VisualFrameManifest>;
  getArtifactBytes(key: string): Promise<Uint8Array>;
  getVerifiedArtifactBytes(input: {
    key: string;
    sha256: string;
  }): Promise<Uint8Array>;
  putVerifiedArtifact(input: {
    key: string;
    bytes: Uint8Array;
    sha256: string;
  }): Promise<void>;
  deleteArtifact(key: string): Promise<void>;
  artifactExists(key: string): Promise<boolean>;
}
