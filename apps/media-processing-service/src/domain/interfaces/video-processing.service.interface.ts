import type {
  ReelEncodingQuality,
  ReelEncodingVariantOutput,
} from '@common/processing/interfaces/reel-encoding-variant.interface';
import type { ReelPixelCrop } from '@common/processing/reel-media-crop';
import type { ReelMediaTrim } from '@common/processing/reel-media-trim';
import type { TranscriptionAudioFormat } from '@common/processing/interfaces/transcription-audio-manifest.interface';

export interface VideoMetadata {
  durationMs?: number;
  width?: number;
  height?: number;
  fps?: number;
  bitrateKbps?: number;
  hasAudio?: boolean;
  rotation?: number;
  codecName?: string;
  pixelFormat?: string;
  audioCodecName?: string;
  fileSizeBytes?: number;
  isVariableFrameRate?: boolean;
}

export interface ReelEncodingVariant {
  name: ReelEncodingQuality;
  width: number;
  height: number;
  bitrateKbps: number;
  maxrateKbps: number;
  bufsizeKbps: number;
  audioBitrateKbps: number;
}

export interface ReelEncodingProfile {
  profileName: 'data_saver' | 'balanced' | 'high';
  outputFps: number;
  segmentSeconds: number;
  x264Preset: string;
  threadsPerVariant: number;
  timeoutMs: number;
  hasAudio: boolean;
  crop?: ReelPixelCrop;
  trim?: ReelMediaTrim;
  variants: ReelEncodingVariant[];
}

export interface TranscodeToHlsResult {
  variantCount: number;
  maxHeight: number;
  outputFps: number;
  segmentSeconds: number;
  variantNames: string[];
  variants: ReelEncodingVariantOutput[];
}

export interface VideoProcessExecutionOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface TranscriptionAudioSegmentRequest {
  outputPath: string;
  startMs: number;
  endMs: number;
  overlapBeforeMs: number;
}

export interface TranscriptionAudioSegmentResult extends TranscriptionAudioSegmentRequest {
  byteLength: number;
}

export interface IVideoProcessingService {
  getVideoMetadata(
    inputPath: string,
    options?: VideoProcessExecutionOptions,
  ): Promise<VideoMetadata>;

  transcodeToHls(
    inputPath: string,
    outputDir: string,
    profile: ReelEncodingProfile,
    options?: VideoProcessExecutionOptions,
  ): Promise<TranscodeToHlsResult>;

  extractTranscriptionAudioSegments(
    inputPath: string,
    segments: TranscriptionAudioSegmentRequest[],
    format: TranscriptionAudioFormat,
    options?: VideoProcessExecutionOptions,
  ): Promise<TranscriptionAudioSegmentResult[]>;

  extractThumbnail(
    inputPath: string,
    outputPath: string,
    timestampSeconds?: number,
    options?: VideoProcessExecutionOptions & {
      crop?: ReelPixelCrop;
      trim?: ReelMediaTrim;
    },
  ): Promise<void>;
}
