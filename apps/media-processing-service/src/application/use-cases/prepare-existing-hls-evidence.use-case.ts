import type { ReelSourceLengthClass, ReelSourceOrientation } from '@common/content/interfaces/reel-state.interface';
import type { ReelPipelineMediaClass, ReelPipelineOrientation } from '@common/processing/interfaces/reel-pipeline-metric.interface';
import type { ReelPipelineMetricContext } from '@common/processing/interfaces/reel-pipeline-metric.interface';
import type { IProcessingMetrics } from '@processing/domain/interfaces/processing-metrics.interface';
import type { IVideoProcessingService } from '@processing/domain/interfaces/video-processing.service.interface';
import { Inject, Injectable } from '@nestjs/common';
import * as path from 'node:path';
import type { IContentService, ReelProcessingMediaMetadata } from '../../domain/interfaces/content-service.interface';
import type { IMediaStorageService } from '../../domain/interfaces/media-storage.service.interface';
import type { ITempFileService } from '../../domain/interfaces/temp-file.service.interface';
import { BuildTranscriptionAudioManifestUseCase } from './build-transcription-audio-manifest.use-case';
import { ClassifyReelMediaUseCase } from './classify-reel-media.use-case';

export interface ExistingHlsEvidenceResult {
  mediaMetadata: ReelProcessingMediaMetadata;
  transcriptionAudioManifestKey: string;
}

@Injectable()
export class PrepareExistingHlsEvidenceUseCase {
  constructor(
    @Inject('IMediaStorageService')
    private readonly mediaStorage: IMediaStorageService,
    @Inject('IVideoProcessingService')
    private readonly videoProcessing: IVideoProcessingService,
    @Inject('ITempFileService')
    private readonly tempFiles: ITempFileService,
    private readonly classifyMedia: ClassifyReelMediaUseCase,
    private readonly buildAudioManifest: BuildTranscriptionAudioManifestUseCase,
    @Inject('IContentService')
    private readonly contentService: IContentService,
    @Inject('IProcessingMetrics')
    private readonly processingMetrics: IProcessingMetrics,
  ) {}

  async execute(input: {
    reelId: string;
    mediaAttemptId: string;
    hlsMasterKey: string;
    inputPath: string;
    audioOutputDir: string;
    metricsContext: ReelPipelineMetricContext;
    fallbackOrientation?: ReelSourceOrientation;
    fallbackLengthClass?: ReelSourceLengthClass;
    preservedSourceDurationMs?: number;
  }): Promise<ExistingHlsEvidenceResult> {
    await this.contentService.emitProcessingStarted({
      reelId: input.reelId,
      status: 'PROCESSING',
      processingAttemptId: input.mediaAttemptId,
      stage: 'LOADING_EXISTING_HLS',
      message: 'Preparing transcript and visual evidence from existing HLS',
      progress: 15,
    });
    await this.mediaStorage.downloadVideo(input.hlsMasterKey, input.inputPath);

    const metadata = await this.videoProcessing.getVideoMetadata(input.inputPath);
    if (
      !metadata.durationMs ||
      metadata.durationMs <= 0 ||
      typeof metadata.hasAudio !== 'boolean'
    ) {
      throw new Error('Existing HLS playlist did not provide valid media metadata');
    }

    const classification = this.classifyMedia.execute(metadata);
    const sourceOrientation = this.resolveOrientation(
      classification.orientation,
      input.fallbackOrientation,
    );
    const sourceLengthClass = this.resolveLengthClass(
      classification.mediaClass,
      input.fallbackLengthClass,
    );
    if (!sourceOrientation || !sourceLengthClass) {
      throw new Error('Existing HLS media could not be classified for indexing');
    }

    input.metricsContext.orientation = sourceOrientation;
    input.metricsContext.mediaClass = sourceLengthClass;
    const sourceStats = this.tempFiles.getPathStats(input.inputPath);
    const mediaMetadata: ReelProcessingMediaMetadata = {
      sourceDurationMs: Math.max(
        input.preservedSourceDurationMs ?? metadata.durationMs,
        metadata.durationMs,
      ),
      outputDurationMs: metadata.durationMs,
      sourceWidth: metadata.width,
      sourceHeight: metadata.height,
      sourceFps: metadata.fps,
      sourceBitrateKbps: metadata.bitrateKbps,
      sourceHasAudio: metadata.hasAudio,
      sourceRotation: metadata.rotation,
      sourceCodec: metadata.codecName,
      sourcePixelFormat: metadata.pixelFormat,
      sourceAudioCodec: metadata.audioCodecName,
      sourceFileSizeBytes: metadata.fileSizeBytes ?? sourceStats.totalBytes,
      sourceVariableFrameRate: metadata.isVariableFrameRate,
      sourceOrientation,
      sourceLengthClass,
      sourceAspectRatio: classification.aspectRatio,
      sourceEffectiveWidth: classification.effectiveWidth,
      sourceEffectiveHeight: classification.effectiveHeight,
    };

    await this.contentService.emitProcessingProgress({
      reelId: input.reelId,
      status: 'PROCESSING',
      processingAttemptId: input.mediaAttemptId,
      stage: 'BUILDING_AUDIO_MANIFEST',
      message: 'Preparing transcription audio',
      progress: 55,
    });
    const audioTimer = this.processingMetrics.startStage(
      input.metricsContext,
      'AUDIO_ARTIFACTS',
    );
    const audioResult = await this.buildAudioManifest.execute({
      reelId: input.reelId,
      mediaAttemptId: input.mediaAttemptId,
      inputPath: input.inputPath,
      outputDir: input.audioOutputDir,
      storagePrefix: path.posix.dirname(input.hlsMasterKey),
      metadata,
    });
    audioTimer.succeed({
      audioArtifactCount: audioResult.manifest.artifacts.length,
      audioArtifactBytes: audioResult.totalAudioBytes,
      audioManifestPayloadBytes: Buffer.byteLength(
        JSON.stringify(audioResult.manifest),
        'utf8',
      ),
    });

    return {
      mediaMetadata,
      transcriptionAudioManifestKey: audioResult.manifestKey,
    };
  }

  private resolveOrientation(
    actual: ReelPipelineOrientation,
    fallback?: ReelSourceOrientation,
  ): ReelSourceOrientation | undefined {
    if (actual === 'PORTRAIT' || actual === 'LANDSCAPE' || actual === 'SQUARE') {
      return actual;
    }
    return fallback;
  }

  private resolveLengthClass(
    actual: ReelPipelineMediaClass,
    fallback?: ReelSourceLengthClass,
  ): ReelSourceLengthClass | undefined {
    if (actual === 'SHORT' || actual === 'LONG') return actual;
    return fallback;
  }
}
