import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ReelMediaEdit } from '@common/content/schemas/reel-edit.schema';
import {
  resolveReelMediaTrim,
  type ReelMediaTrim,
} from '@common/processing/reel-media-trim';
import { VideoMetadata } from '../../domain/interfaces/video-processing.service.interface';

export class ReelSourceMediaValidationError extends Error {
  constructor(
    readonly errorCode: string,
    readonly publicMessage: string,
    readonly detail: string,
  ) {
    super(publicMessage);
    this.name = 'ReelSourceMediaValidationError';
  }
}

@Injectable()
export class ValidateReelSourceMediaUseCase {
  constructor(private readonly configService: ConfigService) {}

  resolveTrim(
    edit: ReelMediaEdit | undefined,
    sourceDurationMs: number,
  ): ReelMediaTrim {
    try {
      return resolveReelMediaTrim(edit, sourceDurationMs);
    } catch (error: unknown) {
      throw new ReelSourceMediaValidationError(
        'VIDEO_TRIM_INVALID',
        'The selected trim interval is invalid for this video.',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  execute(
    metadata: VideoMetadata,
    context?: {
      sourceBytes?: number;
      availableTempBytes?: number;
      estimatedAdditionalTempBytes?: number;
    },
  ): void {
    const minDurationMs =
      this.getPositiveInt('REEL_MIN_DURATION_SECONDS', 1, 1, 30) * 1000;

    const maxDurationMs =
      this.getPositiveInt('MEDIA_LONG_MAX_DURATION_SECONDS', 7200, 10, 86_400) *
      1000;

    const maxSourceLongSide = this.getPositiveInt(
      'REEL_MAX_SOURCE_LONG_SIDE',
      2160,
      480,
      4096,
    );

    const maxSourceFps = this.getPositiveInt(
      'MEDIA_MAX_SOURCE_FPS',
      60,
      24,
      120,
    );
    const maxSourceBytes =
      this.getPositiveInt('MEDIA_MAX_SOURCE_SIZE_MIB', 20_480, 1, 102_400) *
      1024 *
      1024;
    const maxBitrateKbps = this.getPositiveInt(
      'MEDIA_MAX_SOURCE_BITRATE_KBPS',
      100_000,
      1000,
      1_000_000,
    );

    if (!metadata.durationMs || metadata.durationMs <= 0) {
      throw new ReelSourceMediaValidationError(
        'VIDEO_METADATA_UNREADABLE',
        'This video format is not supported.',
        'Video duration is missing or invalid.',
      );
    }

    if (!metadata.width || !metadata.height) {
      throw new ReelSourceMediaValidationError(
        'VIDEO_METADATA_UNREADABLE',
        'This video format is not supported.',
        'Video width or height is missing.',
      );
    }

    if (!metadata.codecName?.trim() || !metadata.pixelFormat?.trim()) {
      throw new ReelSourceMediaValidationError(
        'VIDEO_CODEC_UNREADABLE',
        'This video format is not supported.',
        'Video codec or pixel format metadata is missing.',
      );
    }

    if (!metadata.fps || metadata.fps <= 0) {
      throw new ReelSourceMediaValidationError(
        'VIDEO_FRAME_RATE_UNREADABLE',
        'This video format is not supported.',
        'Video frame rate metadata is missing or invalid.',
      );
    }

    if (metadata.durationMs < minDurationMs) {
      throw new ReelSourceMediaValidationError(
        'VIDEO_TOO_SHORT',
        'This video is too short. Please upload a longer reel.',
        `Video duration ${metadata.durationMs}ms is below minimum ${minDurationMs}ms.`,
      );
    }

    if (metadata.durationMs > maxDurationMs) {
      throw new ReelSourceMediaValidationError(
        'VIDEO_TOO_LONG',
        'This video is too long. Please upload a shorter reel.',
        `Video duration ${metadata.durationMs}ms exceeds maximum ${maxDurationMs}ms.`,
      );
    }

    const effectiveWidth = this.getEffectiveWidth(metadata);
    const effectiveHeight = this.getEffectiveHeight(metadata);
    const longSide = Math.max(effectiveWidth, effectiveHeight);

    if (longSide > maxSourceLongSide) {
      throw new ReelSourceMediaValidationError(
        'VIDEO_RESOLUTION_TOO_HIGH',
        'This video is too large. Please upload a smaller reel.',
        `Video long side ${longSide}px exceeds maximum ${maxSourceLongSide}px.`,
      );
    }

    if (metadata.fps && metadata.fps > maxSourceFps + 1) {
      throw new ReelSourceMediaValidationError(
        'VIDEO_FPS_TOO_HIGH',
        'This video format is not supported.',
        `Video FPS ${metadata.fps} exceeds maximum ${maxSourceFps}.`,
      );
    }

    if (metadata.bitrateKbps && metadata.bitrateKbps > maxBitrateKbps) {
      throw new ReelSourceMediaValidationError(
        'VIDEO_BITRATE_TOO_HIGH',
        'This video bitrate is too high. Please upload a smaller video.',
        `Video bitrate ${metadata.bitrateKbps}Kbps exceeds maximum ${maxBitrateKbps}Kbps.`,
      );
    }

    const sourceBytes = context?.sourceBytes ?? metadata.fileSizeBytes;

    if (sourceBytes && sourceBytes > maxSourceBytes) {
      throw new ReelSourceMediaValidationError(
        'VIDEO_FILE_TOO_LARGE',
        'This video file is too large. Please upload a smaller video.',
        `Video file size ${sourceBytes} bytes exceeds maximum ${maxSourceBytes} bytes.`,
      );
    }

    if (
      context?.availableTempBytes !== undefined &&
      context.estimatedAdditionalTempBytes !== undefined &&
      context.availableTempBytes < context.estimatedAdditionalTempBytes
    ) {
      throw new ReelSourceMediaValidationError(
        'INSUFFICIENT_TEMP_STORAGE',
        'This video cannot be processed right now. Please try again later.',
        `Available temporary disk ${context.availableTempBytes} bytes is below estimated requirement ${context.estimatedAdditionalTempBytes} bytes.`,
      );
    }
  }

  private getPositiveInt(
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const parsed = Number(this.configService.get<string>(key) ?? fallback);

    if (!Number.isFinite(parsed)) {
      return fallback;
    }

    return Math.min(max, Math.max(min, Math.round(parsed)));
  }

  private getEffectiveWidth(metadata: VideoMetadata): number {
    if (metadata.rotation === 90 || metadata.rotation === 270) {
      return metadata.height ?? 0;
    }

    return metadata.width ?? 0;
  }

  private getEffectiveHeight(metadata: VideoMetadata): number {
    if (metadata.rotation === 90 || metadata.rotation === 270) {
      return metadata.width ?? 0;
    }

    return metadata.height ?? 0;
  }
}
