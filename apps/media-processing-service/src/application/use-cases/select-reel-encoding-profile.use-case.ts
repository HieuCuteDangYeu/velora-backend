import type { ReelSourceOrientation } from '@common/content/interfaces/reel-state.interface';
import type { ReelMediaEdit } from '@common/content/schemas/reel-edit.schema';
import { resolveReelPixelCrop } from '@common/processing/reel-media-crop';
import type { ReelMediaTrim } from '@common/processing/reel-media-trim';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  ReelEncodingProfile,
  ReelEncodingVariant,
  VideoMetadata,
} from '../../domain/interfaces/video-processing.service.interface';

type ReelHlsQualityProfile = 'data_saver' | 'balanced' | 'high';

const ORIENTATION_LADDERS: Record<
  ReelSourceOrientation,
  Array<Pick<ReelEncodingVariant, 'name' | 'width' | 'height'>>
> = {
  PORTRAIT: [
    { name: '360p', width: 360, height: 640 },
    { name: '540p', width: 540, height: 960 },
    { name: '720p', width: 720, height: 1280 },
    { name: '1080p', width: 1080, height: 1920 },
  ],
  LANDSCAPE: [
    { name: '360p', width: 640, height: 360 },
    { name: '540p', width: 960, height: 540 },
    { name: '720p', width: 1280, height: 720 },
    { name: '1080p', width: 1920, height: 1080 },
  ],
  SQUARE: [
    { name: '360p', width: 360, height: 360 },
    { name: '540p', width: 540, height: 540 },
    { name: '720p', width: 720, height: 720 },
    { name: '1080p', width: 1080, height: 1080 },
  ],
};

const BITRATES: Record<
  ReelEncodingVariant['name'],
  Pick<
    ReelEncodingVariant,
    'bitrateKbps' | 'maxrateKbps' | 'bufsizeKbps' | 'audioBitrateKbps'
  >
> = {
  '360p': {
    bitrateKbps: 750,
    maxrateKbps: 950,
    bufsizeKbps: 1500,
    audioBitrateKbps: 96,
  },
  '540p': {
    bitrateKbps: 1400,
    maxrateKbps: 1800,
    bufsizeKbps: 2800,
    audioBitrateKbps: 112,
  },
  '720p': {
    bitrateKbps: 2400,
    maxrateKbps: 3100,
    bufsizeKbps: 4800,
    audioBitrateKbps: 128,
  },
  '1080p': {
    bitrateKbps: 4800,
    maxrateKbps: 6200,
    bufsizeKbps: 9600,
    audioBitrateKbps: 160,
  },
};

@Injectable()
export class SelectReelEncodingProfileUseCase {
  constructor(private readonly configService: ConfigService) {}

  execute(
    metadata: VideoMetadata,
    edit?: ReelMediaEdit,
    processingDurationMs?: number,
    trim?: ReelMediaTrim,
  ): ReelEncodingProfile {
    const profileName = this.getQualityProfile();
    const sourceDimensions = this.getEffectiveDimensions(metadata);
    const crop = resolveReelPixelCrop(edit, metadata);
    const sourceWidth = crop?.width ?? sourceDimensions.width;
    const sourceHeight = crop?.height ?? sourceDimensions.height;
    const orientation = crop
      ? 'PORTRAIT'
      : this.getOrientation(sourceWidth, sourceHeight);
    const allow1080p = this.getBoolean('MEDIA_ALLOW_1080P', false);
    const maxVariants = Math.min(
      this.getPositiveInt(
        'MEDIA_HLS_MAX_VARIANTS',
        profileName === 'data_saver' ? 2 : profileName === 'high' ? 4 : 3,
        1,
        4,
      ),
      profileName === 'data_saver' ? 2 : profileName === 'balanced' ? 3 : 4,
    );
    const candidates = ORIENTATION_LADDERS[orientation]
      .filter((variant) => allow1080p || variant.name !== '1080p')
      .filter(
        (variant) =>
          variant.width <= sourceWidth && variant.height <= sourceHeight,
      )
      .slice(0, maxVariants);
    const selected =
      candidates.length > 0
        ? candidates
        : [this.createSourceSizedFallback(sourceWidth, sourceHeight)];
    const variants = selected.map((variant) => ({
      ...variant,
      ...BITRATES[variant.name],
    }));
    const shortMaxDurationMs =
      this.getPositiveInt('MEDIA_SHORT_MAX_DURATION_SECONDS', 180, 1, 86_400) *
      1000;
    const durationMs = processingDurationMs ?? metadata.durationMs;
    const isLong = (durationMs ?? 0) > shortMaxDurationMs;
    const segmentSeconds = isLong
      ? this.getPositiveInt('MEDIA_LONG_HLS_SEGMENT_SECONDS', 4, 2, 20)
      : this.getPositiveInt('MEDIA_SHORT_HLS_SEGMENT_SECONDS', 2, 1, 10);
    const allow60Fps = this.getBoolean('MEDIA_ALLOW_60FPS', false);
    const sourceFps = metadata.fps ?? 30;
    const outputFps =
      allow60Fps && sourceFps >= 50 ? 60 : Math.min(30, sourceFps);

    return {
      profileName,
      outputFps: Math.max(24, Math.round(outputFps)),
      segmentSeconds,
      x264Preset:
        this.configService.get<string>('MEDIA_HLS_X264_PRESET')?.trim() ||
        'faster',
      threadsPerVariant: this.getPositiveInt(
        'MEDIA_FFMPEG_THREADS_PER_VARIANT',
        2,
        1,
        16,
      ),
      timeoutMs: this.getTranscodeTimeoutMs(durationMs),
      hasAudio: metadata.hasAudio === true,
      ...(crop ? { crop } : {}),
      ...(trim ? { trim } : {}),
      variants,
    };
  }

  private getEffectiveDimensions(metadata: VideoMetadata): {
    width: number;
    height: number;
  } {
    const width = Math.max(2, this.toEven(metadata.width ?? 2));
    const height = Math.max(2, this.toEven(metadata.height ?? 2));
    const rotation = (((metadata.rotation ?? 0) % 360) + 360) % 360;

    return rotation === 90 || rotation === 270
      ? { width: height, height: width }
      : { width, height };
  }

  private getOrientation(width: number, height: number): ReelSourceOrientation {
    const ratio = width / height;

    if (ratio >= 1.1) return 'LANDSCAPE';
    if (ratio <= 0.9) return 'PORTRAIT';
    return 'SQUARE';
  }

  private createSourceSizedFallback(
    sourceWidth: number,
    sourceHeight: number,
  ): Pick<ReelEncodingVariant, 'name' | 'width' | 'height'> {
    return {
      name: '360p',
      width: Math.max(2, this.toEven(sourceWidth)),
      height: Math.max(2, this.toEven(sourceHeight)),
    };
  }

  private getTranscodeTimeoutMs(durationMs?: number): number {
    const baseMs = this.getPositiveInt(
      'MEDIA_FFMPEG_TIMEOUT_BASE_MS',
      300_000,
      30_000,
      3_600_000,
    );
    const multiplier = this.getPositiveNumber(
      'MEDIA_FFMPEG_TIMEOUT_DURATION_MULTIPLIER',
      3,
      1,
      20,
    );
    const derivedMs = Math.round((durationMs ?? 0) * multiplier + baseMs);

    return Math.min(28_800_000, Math.max(baseMs, derivedMs));
  }

  private getQualityProfile(): ReelHlsQualityProfile {
    const value = this.configService
      .get<string>('MEDIA_HLS_QUALITY_PROFILE')
      ?.trim()
      .toLowerCase();

    if (value === 'data_saver' || value === 'balanced' || value === 'high') {
      return value;
    }

    return 'balanced';
  }

  private toEven(value: number): number {
    return Math.max(2, Math.floor(value / 2) * 2);
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

    if (!Number.isFinite(parsed)) {
      return fallback;
    }

    return Math.min(max, Math.max(min, parsed));
  }

  private getBoolean(key: string, fallback: boolean): boolean {
    const value = this.configService.get<string>(key)?.trim().toLowerCase();

    if (!value) return fallback;
    if (['1', 'true', 'yes', 'on'].includes(value)) return true;
    if (['0', 'false', 'no', 'off'].includes(value)) return false;
    return fallback;
  }
}
