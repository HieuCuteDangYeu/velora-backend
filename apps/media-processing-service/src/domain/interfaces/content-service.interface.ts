import type {
  ReelSourceLengthClass,
  ReelSourceOrientation,
} from '@common/content/interfaces/reel-state.interface';
import type { ReelMediaOutput } from '@common/processing/interfaces/reel-media-output.interface';
import type { ReelPipelineMetricContext } from '@common/processing/interfaces/reel-pipeline-metric.interface';

export interface ReelProcessingMediaMetadata {
  sourceDurationMs?: number;
  outputDurationMs?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  sourceFps?: number;
  sourceBitrateKbps?: number;
  sourceHasAudio?: boolean;
  sourceRotation?: number;
  sourceCodec?: string;
  sourcePixelFormat?: string;
  sourceAudioCodec?: string;
  sourceFileSizeBytes?: number;
  sourceVariableFrameRate?: boolean;
  sourceOrientation?: ReelSourceOrientation;
  sourceLengthClass?: ReelSourceLengthClass;
  sourceAspectRatio?: number;
  sourceEffectiveWidth?: number;
  sourceEffectiveHeight?: number;
  encodedVariantCount?: number;
  encodedMaxHeight?: number;
  encodedFps?: number;
}

export interface IContentService {
  claimReelProcessingAttempt(data: {
    reelId: string;
    processingAttemptId: string;
    allowReclaim?: boolean;
  }): Promise<boolean>;

  emitProcessingStarted(data: {
    reelId: string;
    status: 'PROCESSING';
    processingAttemptId?: string;
    stage?: string;
    message?: string;
    progress?: number;
  }): Promise<void>;

  emitProcessingProgress(data: {
    reelId: string;
    status: 'PROCESSING';
    processingAttemptId?: string;
    stage?: string;
    message?: string;
    progress?: number;
  }): Promise<void>;

  persistProcessingRetryScheduled(data: {
    reelId: string;
    status: 'PENDING';
    processingAttemptId: string;
    stage: 'RETRY_SCHEDULED';
    message: string;
    progress: number;
  }): Promise<void>;

  persistMediaCompleted(data: {
    reelId: string;
    processingAttemptId: string;
    mediaMetadata: ReelProcessingMediaMetadata;
    mediaOutput: ReelMediaOutput;
  }): Promise<boolean>;

  emitProcessingFailed(data: {
    reelId: string;
    status: 'FAILED';
    processingAttemptId?: string;
    stage?: string;
    message?: string;
    progress?: number;
    errorCode?: string;
    errorDetail?: string;
    mediaMetadata?: ReelProcessingMediaMetadata;
    metricsContext?: ReelPipelineMetricContext;
  }): Promise<void>;
}
