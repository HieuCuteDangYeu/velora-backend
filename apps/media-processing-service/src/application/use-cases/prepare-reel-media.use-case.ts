import type { ReelMediaOutput } from '@common/processing/interfaces/reel-media-output.interface';
import type { ReelMediaEdit } from '@common/content/schemas/reel-edit.schema';
import type { ReelPixelCrop } from '@common/processing/reel-media-crop';
import type { ReelMediaTrim } from '@common/processing/reel-media-trim';
import type { ReelPipelineMetricContext } from '@common/processing/interfaces/reel-pipeline-metric.interface';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IProcessingMetrics } from '@processing/domain/interfaces/processing-metrics.interface';
import type {
  IContentService,
  ReelProcessingMediaMetadata,
} from '../../domain/interfaces/content-service.interface';
import type { IMediaStorageService } from '../../domain/interfaces/media-storage.service.interface';
import type { ITempFileService } from '../../domain/interfaces/temp-file.service.interface';
import type {
  ReelEncodingProfile,
  IVideoProcessingService,
  TranscodeToHlsResult,
  VideoMetadata,
} from '../../domain/interfaces/video-processing.service.interface';
import * as path from 'node:path';
import { formatProcessingError } from '../utils/format-processing-error';
import { BuildTranscriptionAudioManifestUseCase } from './build-transcription-audio-manifest.use-case';
import {
  ClassifyReelMediaUseCase,
  ReelMediaClassification,
} from './classify-reel-media.use-case';
import { SelectReelEncodingProfileUseCase } from './select-reel-encoding-profile.use-case';
import {
  ReelSourceMediaValidationError,
  ValidateReelSourceMediaUseCase,
} from './validate-reel-source-media.use-case';
import {
  ReelStreamValidationError,
  ValidateReelStreamUseCase,
} from './validate-reel-stream.use-case';

export class PrepareReelMediaError extends Error {
  readonly stage: string;
  readonly publicMessage: string;
  readonly errorCode: string;
  readonly mediaMetadata?: ReelProcessingMediaMetadata;
  readonly retryable: boolean;

  constructor(
    error: unknown,
    readonly progress: number,
    options: {
      stage?: string;
      publicMessage?: string;
      errorCode?: string;
      mediaMetadata?: ReelProcessingMediaMetadata;
      retryable?: boolean;
    } = {},
  ) {
    const { message, stack } = formatProcessingError(error);

    super(message);
    this.stack = stack;
    this.stage = options.stage ?? 'FAILED';
    this.publicMessage = options.publicMessage ?? 'Video processing failed';
    this.errorCode = options.errorCode ?? this.stage;
    this.mediaMetadata = options.mediaMetadata;
    this.retryable = options.retryable ?? this.isRetryable(error);
  }

  private isRetryable(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'retryable' in error &&
      error.retryable === true
    );
  }
}

@Injectable()
export class PrepareReelMediaUseCase {
  private readonly logger = new Logger(PrepareReelMediaUseCase.name);

  constructor(
    private readonly configService: ConfigService,
    @Inject('IMediaStorageService')
    private readonly mediaStorageService: IMediaStorageService,
    @Inject('IVideoProcessingService')
    private readonly videoProcessingService: IVideoProcessingService,
    @Inject('IContentService')
    private readonly contentService: IContentService,
    @Inject('ITempFileService')
    private readonly tempFileService: ITempFileService,
    @Inject('IProcessingMetrics')
    private readonly processingMetrics: IProcessingMetrics,
    private readonly validateReelStreamUseCase: ValidateReelStreamUseCase,
    private readonly validateReelSourceMediaUseCase: ValidateReelSourceMediaUseCase,
    private readonly selectReelEncodingProfileUseCase: SelectReelEncodingProfileUseCase,
    private readonly classifyReelMediaUseCase: ClassifyReelMediaUseCase,
    private readonly buildTranscriptionAudioManifestUseCase: BuildTranscriptionAudioManifestUseCase,
  ) {}

  async execute(data: {
    reelId: string;
    mediaKey: string;
    processingAttemptId: string;
    workDir: string;
    inputPath: string;
    hlsOutputDir: string;
    audioOutputDir: string;
    thumbnailPath: string;
    metricsContext: ReelPipelineMetricContext;
    edit?: ReelMediaEdit;
  }): Promise<{
    mediaMetadata: ReelProcessingMediaMetadata;
    mediaOutput: ReelMediaOutput;
    crop?: ReelPixelCrop;
    trim?: ReelMediaTrim;
  }> {
    let currentProgress = 10;
    let currentStage = 'DOWNLOADING';
    let currentPublicMessage = 'Video processing failed';
    let currentErrorCode = 'PROCESSING_FAILED';
    let mediaMetadata: ReelProcessingMediaMetadata | undefined;
    let classification: ReelMediaClassification | undefined;
    let processingClassification: ReelMediaClassification | undefined;
    let processingTrim: ReelMediaTrim | undefined;
    const totalMediaTimer = this.processingMetrics.startStage(
      data.metricsContext,
      'TOTAL_MEDIA',
    );

    try {
      await this.contentService.emitProcessingStarted({
        reelId: data.reelId,
        status: 'PROCESSING',
        processingAttemptId: data.processingAttemptId,
        stage: currentStage,
        message: 'Downloading source video',
        progress: currentProgress,
      });

      const downloadTimer = this.processingMetrics.startStage(
        data.metricsContext,
        'SOURCE_DOWNLOAD',
      );
      await this.mediaStorageService.downloadVideo(
        data.mediaKey,
        data.inputPath,
      );
      const sourceStats = this.tempFileService.getPathStats(data.inputPath);
      const sourceChecksum = await this.tempFileService.getFileChecksum(
        data.inputPath,
      );
      downloadTimer.succeed({
        sourceBytes: sourceStats.totalBytes,
        temporaryDiskBytes: sourceStats.totalBytes,
      });

      currentProgress = 20;
      currentStage = 'PROBING_SOURCE';
      currentErrorCode = 'SOURCE_PROBE_FAILED';
      currentPublicMessage =
        'This video could not be processed. Please try another video.';
      await this.emitProgress(data, currentStage, 'Checking source video', 20);

      const probeTimer = this.processingMetrics.startStage(
        data.metricsContext,
        'FFPROBE',
      );
      const sourceMetadata = await this.videoProcessingService.getVideoMetadata(
        data.inputPath,
      );
      classification = this.classifyReelMediaUseCase.execute(sourceMetadata);
      data.metricsContext.mediaClass = classification.mediaClass;
      data.metricsContext.orientation = classification.orientation;
      probeTimer.succeed(
        this.toSourceMetricDetails(sourceMetadata, classification),
      );
      mediaMetadata = this.toSourceMetadata(sourceMetadata, classification);

      const validationTimer = this.processingMetrics.startStage(
        data.metricsContext,
        'SOURCE_VALIDATION',
      );
      this.validateReelSourceMediaUseCase.execute(sourceMetadata, {
        sourceBytes: sourceStats.totalBytes,
      });

      currentStage = 'VALIDATING_TRIM';
      currentErrorCode = 'VIDEO_TRIM_INVALID';
      processingTrim = this.validateReelSourceMediaUseCase.resolveTrim(
        data.edit,
        sourceMetadata.durationMs!,
      );
      processingClassification = this.classifyReelMediaUseCase.execute({
        ...sourceMetadata,
        durationMs: processingTrim.outputDurationMs,
      });
      data.metricsContext.mediaClass = processingClassification.mediaClass;
      mediaMetadata = {
        ...mediaMetadata,
        outputDurationMs: processingTrim.outputDurationMs,
      };
      const ffmpegTrim = data.edit?.trim ? processingTrim : undefined;
      const processingMetadata = {
        ...sourceMetadata,
        durationMs: processingTrim.outputDurationMs,
      };

      const profileTimer = this.processingMetrics.startStage(
        data.metricsContext,
        'PROFILE_SELECTION',
      );
      const encodingProfile = this.selectReelEncodingProfileUseCase.execute(
        sourceMetadata,
        data.edit,
        processingTrim.outputDurationMs,
        ffmpegTrim,
      );
      const estimatedAdditionalTempBytes = this.estimateAdditionalTempBytes(
        processingMetadata,
        encodingProfile,
      );
      const availableTempBytes = this.tempFileService.getAvailableBytes(
        data.workDir,
      );

      this.validateReelSourceMediaUseCase.execute(sourceMetadata, {
        sourceBytes: sourceStats.totalBytes,
        availableTempBytes,
        estimatedAdditionalTempBytes,
      });
      validationTimer.succeed({
        ...this.toSourceMetricDetails(sourceMetadata, classification),
        availableTempBytes,
        estimatedAdditionalTempBytes,
      });
      profileTimer.succeed({
        profileName: encodingProfile.profileName,
        outputFps: encodingProfile.outputFps,
        hlsSegmentSeconds: encodingProfile.segmentSeconds,
        threadsPerVariant: encodingProfile.threadsPerVariant,
        ffmpegTimeoutMs: encodingProfile.timeoutMs,
        variants: encodingProfile.variants.map(({ name, width, height }) => ({
          name,
          width,
          height,
        })),
      });

      currentProgress = 35;
      currentStage = 'TRANSCODING';
      currentErrorCode = 'TRANSCODING_FAILED';
      await this.emitProgress(
        data,
        currentStage,
        'Transcoding video for streaming',
        currentProgress,
      );
      const transcodeTimer = this.processingMetrics.startStage(
        data.metricsContext,
        'FFMPEG_TRANSCODE',
      );
      const transcodeResult = await this.videoProcessingService.transcodeToHls(
        data.inputPath,
        data.hlsOutputDir,
        encodingProfile,
      );
      const hlsStats = this.tempFileService.getPathStats(data.hlsOutputDir);
      const localMasterPath = path.join(data.hlsOutputDir, 'master.m3u8');
      const hlsMasterChecksum =
        await this.tempFileService.getFileChecksum(localMasterPath);
      transcodeTimer.succeed({
        ffmpegCpuUsagePercent: null,
        ffmpegCpuMeasurement: 'not_exposed_by_spawn_adapter',
        hlsObjectCount: hlsStats.fileCount,
        hlsTotalBytes: hlsStats.totalBytes,
        temporaryDiskBytes: sourceStats.totalBytes + hlsStats.totalBytes,
        actualVariantDimensions: transcodeResult.variants,
      });
      mediaMetadata = {
        ...mediaMetadata,
        ...this.toEncodedMetadata(transcodeResult),
      };

      const storagePrefix = data.mediaKey.replace(/\.[^.]+$/, '');
      const hlsMasterKey = `${storagePrefix}/master.m3u8`;

      currentProgress = 60;
      currentStage = 'UPLOADING_STREAM';
      currentErrorCode = 'STREAM_UPLOAD_FAILED';
      await this.mediaStorageService.deleteObjectsByPrefix(storagePrefix);
      await this.emitProgress(
        data,
        currentStage,
        'Uploading streaming files',
        currentProgress,
      );
      const uploadTimer = this.processingMetrics.startStage(
        data.metricsContext,
        'HLS_UPLOAD',
      );
      await this.mediaStorageService.uploadHlsDirectory(
        data.hlsOutputDir,
        storagePrefix,
      );
      uploadTimer.succeed({
        hlsObjectCount: hlsStats.fileCount,
        hlsTotalBytes: hlsStats.totalBytes,
      });

      currentProgress = 72;
      currentStage = 'GENERATING_THUMBNAIL';
      currentErrorCode = 'THUMBNAIL_FAILED';
      await this.emitProgress(
        data,
        currentStage,
        'Generating reel thumbnail',
        currentProgress,
      );
      const thumbnailTimer = this.processingMetrics.startStage(
        data.metricsContext,
        'THUMBNAIL',
      );
      const thumbnailKey = `${storagePrefix}/thumbnail.jpg`;
      const thumbnailTimestampSeconds = this.resolveThumbnailTimestampSeconds(
        sourceMetadata,
        processingClassification,
        processingTrim.outputDurationMs,
      );
      await this.videoProcessingService.extractThumbnail(
        data.inputPath,
        data.thumbnailPath,
        thumbnailTimestampSeconds,
        { crop: encodingProfile.crop, trim: encodingProfile.trim },
      );
      const thumbnailChecksum = await this.tempFileService.getFileChecksum(
        data.thumbnailPath,
      );
      await this.mediaStorageService.uploadThumbnail(
        data.thumbnailPath,
        thumbnailKey,
      );
      const thumbnailStats = this.tempFileService.getPathStats(
        data.thumbnailPath,
      );
      thumbnailTimer.succeed({
        thumbnailBytes: thumbnailStats.totalBytes,
        thumbnailTimestampSeconds,
      });

      currentProgress = 82;
      currentStage = 'BUILDING_AUDIO_MANIFEST';
      currentErrorCode = 'AUDIO_ARTIFACT_FAILED';
      await this.emitProgress(
        data,
        currentStage,
        'Preparing transcription audio',
        currentProgress,
      );
      const audioTimer = this.processingMetrics.startStage(
        data.metricsContext,
        'AUDIO_ARTIFACTS',
      );
      const audioResult =
        await this.buildTranscriptionAudioManifestUseCase.execute({
          reelId: data.reelId,
          mediaAttemptId: data.processingAttemptId,
          inputPath: data.inputPath,
          outputDir: data.audioOutputDir,
          storagePrefix,
          metadata: sourceMetadata,
          trim: data.edit?.trim ? processingTrim : undefined,
        });
      audioTimer.succeed({
        audioArtifactCount: audioResult.manifest.artifacts.length,
        audioArtifactBytes: audioResult.totalAudioBytes,
        audioManifestPayloadBytes: Buffer.byteLength(
          JSON.stringify(audioResult.manifest),
          'utf8',
        ),
      });

      currentProgress = 90;
      currentStage = 'VALIDATING_STREAM';
      currentErrorCode = 'STREAM_VALIDATION_FAILED';
      currentPublicMessage =
        'Streaming files could not be prepared. Please try again.';
      await this.emitProgress(
        data,
        currentStage,
        'Checking streaming files',
        currentProgress,
      );
      const validationStreamTimer = this.processingMetrics.startStage(
        data.metricsContext,
        'STREAM_VALIDATION',
      );
      await this.validateReelStreamUseCase.execute({
        reelId: data.reelId,
        s3Prefix: storagePrefix,
        thumbnailKey,
      });
      validationStreamTimer.succeed();

      if (
        processingClassification.mediaClass !== 'SHORT' &&
        processingClassification.mediaClass !== 'LONG'
      ) {
        throw new Error('Validated media has no length classification');
      }

      const mediaOutput: ReelMediaOutput = {
        hlsMasterKey,
        thumbnailKey,
        transcriptionAudioManifestKey: audioResult.manifestKey,
        sourceHasAudio: sourceMetadata.hasAudio === true,
        sourceLengthClass: processingClassification.mediaClass,
        variants: transcodeResult.variants,
        hlsObjectCount: hlsStats.fileCount,
        hlsTotalBytes: hlsStats.totalBytes,
        checksums: {
          sourceSha256: sourceChecksum,
          hlsMasterSha256: hlsMasterChecksum,
          thumbnailSha256: thumbnailChecksum,
          transcriptionAudioManifestSha256: audioResult.manifestChecksum,
        },
      };

      totalMediaTimer.succeed({
        ...this.toSourceMetricDetails(sourceMetadata, classification),
        encodedVariantCount: transcodeResult.variantCount,
        actualVariantDimensions: transcodeResult.variants,
        audioArtifactCount: audioResult.manifest.artifacts.length,
      });

      return {
        mediaMetadata,
        mediaOutput,
        crop: encodingProfile.crop,
        trim: encodingProfile.trim,
      };
    } catch (error: unknown) {
      totalMediaTimer.fail(
        error instanceof ReelSourceMediaValidationError
          ? error.errorCode
          : currentStage,
        { ...(mediaMetadata ?? {}) },
      );

      if (error instanceof ReelSourceMediaValidationError) {
        throw new PrepareReelMediaError(error, currentProgress, {
          stage: error.errorCode,
          errorCode: error.errorCode,
          publicMessage: error.publicMessage,
          mediaMetadata,
        });
      }

      if (error instanceof ReelStreamValidationError) {
        throw new PrepareReelMediaError(error, currentProgress, {
          stage: 'STREAM_VALIDATION_FAILED',
          errorCode: 'STREAM_VALIDATION_FAILED',
          publicMessage: error.message,
          mediaMetadata,
        });
      }

      throw new PrepareReelMediaError(error, currentProgress, {
        stage: currentStage,
        errorCode: currentErrorCode,
        publicMessage: currentPublicMessage,
        mediaMetadata,
      });
    }
  }

  private estimateAdditionalTempBytes(
    metadata: VideoMetadata,
    profile: ReelEncodingProfile,
  ): number {
    const durationSeconds = Math.max(1, (metadata.durationMs ?? 0) / 1000);
    const videoKbps = profile.variants.reduce(
      (total, variant) => total + variant.maxrateKbps,
      0,
    );
    const audioKbps = profile.hasAudio
      ? profile.variants.reduce(
          (total, variant) => total + variant.audioBitrateKbps,
          0,
        )
      : 0;
    const hlsBytes = ((videoKbps + audioKbps) * 1000 * durationSeconds) / 8;
    const transcriptionBytes = metadata.hasAudio ? durationSeconds * 32_000 : 0;
    const safetyBytes =
      this.getPositiveInt('MEDIA_TEMP_DISK_SAFETY_MIB', 512, 64, 8192) *
      1024 *
      1024;

    return Math.ceil((hlsBytes + transcriptionBytes) * 1.2 + safetyBytes);
  }

  private resolveThumbnailTimestampSeconds(
    metadata: VideoMetadata,
    classification: ReelMediaClassification,
    durationMs = metadata.durationMs,
  ): number {
    const durationSeconds = Math.max(0, (durationMs ?? 0) / 1000);

    if (durationSeconds <= 0.4) return 0;

    const upperBound = Math.max(0.2, durationSeconds - 0.2);

    if (classification.mediaClass !== 'LONG') {
      return Math.min(2, upperBound);
    }

    const percentage = this.getPositiveNumber(
      'MEDIA_LONG_THUMBNAIL_PERCENT',
      5,
      1,
      20,
    );
    const maxEarlySeconds = this.getPositiveInt(
      'MEDIA_LONG_THUMBNAIL_MAX_SECONDS',
      120,
      2,
      600,
    );

    return Math.min(
      upperBound,
      maxEarlySeconds,
      Math.max(2, durationSeconds * (percentage / 100)),
    );
  }

  private toSourceMetadata(
    metadata: VideoMetadata,
    classification: ReelMediaClassification,
  ): ReelProcessingMediaMetadata {
    return {
      sourceDurationMs: metadata.durationMs,
      sourceWidth: metadata.width,
      sourceHeight: metadata.height,
      sourceFps: metadata.fps,
      sourceBitrateKbps: metadata.bitrateKbps,
      sourceHasAudio: metadata.hasAudio,
      sourceRotation: metadata.rotation,
      sourceCodec: metadata.codecName,
      sourcePixelFormat: metadata.pixelFormat,
      sourceAudioCodec: metadata.audioCodecName,
      sourceFileSizeBytes: metadata.fileSizeBytes,
      sourceVariableFrameRate: metadata.isVariableFrameRate,
      ...(classification.orientation !== 'UNKNOWN'
        ? { sourceOrientation: classification.orientation }
        : {}),
      ...(classification.mediaClass !== 'UNKNOWN'
        ? { sourceLengthClass: classification.mediaClass }
        : {}),
      sourceAspectRatio: classification.aspectRatio,
      sourceEffectiveWidth: classification.effectiveWidth,
      sourceEffectiveHeight: classification.effectiveHeight,
    };
  }

  private toEncodedMetadata(
    result: TranscodeToHlsResult,
  ): ReelProcessingMediaMetadata {
    return {
      encodedVariantCount: result.variantCount,
      encodedMaxHeight: result.maxHeight,
      encodedFps: result.outputFps,
    };
  }

  private toSourceMetricDetails(
    metadata: VideoMetadata,
    classification?: ReelMediaClassification,
  ): Record<string, unknown> {
    return {
      sourceDurationMs: metadata.durationMs,
      sourceWidth: metadata.width,
      sourceHeight: metadata.height,
      sourceFps: metadata.fps,
      sourceBitrateKbps: metadata.bitrateKbps,
      sourceHasAudio: metadata.hasAudio,
      sourceRotation: metadata.rotation ?? 0,
      sourceCodec: metadata.codecName,
      sourcePixelFormat: metadata.pixelFormat,
      sourceFileSizeBytes: metadata.fileSizeBytes,
      sourceVariableFrameRate: metadata.isVariableFrameRate,
      sourceEffectiveWidth: classification?.effectiveWidth,
      sourceEffectiveHeight: classification?.effectiveHeight,
      sourceAspectRatio: classification?.aspectRatio,
      lengthClassification: classification?.mediaClass ?? 'UNKNOWN',
      orientationClassification: classification?.orientation ?? 'UNKNOWN',
    };
  }

  private async emitProgress(
    data: { reelId: string; processingAttemptId: string },
    stage: string,
    message: string,
    progress: number,
  ): Promise<void> {
    try {
      await this.contentService.emitProcessingProgress({
        reelId: data.reelId,
        status: 'PROCESSING',
        processingAttemptId: data.processingAttemptId,
        stage,
        message,
        progress,
      });
    } catch (error: unknown) {
      const { message: detail, stack } = formatProcessingError(error);
      this.logger.warn(
        `[Reel ${data.reelId}] Failed to publish processing progress: ${detail}`,
        stack,
      );
    }
  }

  private getPositiveInt(
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    return Math.round(this.getPositiveNumber(key, fallback, min, max));
  }

  private getPositiveNumber(
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const parsed = Number(this.configService.get<string>(key) ?? fallback);

    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }
}
