import type {
  TranscriptionAudioArtifact,
  TranscriptionAudioFormat,
  TranscriptionAudioManifest,
} from '@common/processing/interfaces/transcription-audio-manifest.interface';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as path from 'node:path';
import type { IMediaStorageService } from '../../domain/interfaces/media-storage.service.interface';
import type { ITempFileService } from '../../domain/interfaces/temp-file.service.interface';
import type {
  IVideoProcessingService,
  TranscriptionAudioSegmentRequest,
  VideoMetadata,
} from '../../domain/interfaces/video-processing.service.interface';
import type { ReelMediaTrim } from '@common/processing/reel-media-trim';

export interface TranscriptionAudioManifestResult {
  manifest: TranscriptionAudioManifest;
  manifestKey: string;
  manifestChecksum: string;
  totalAudioBytes: number;
}

@Injectable()
export class BuildTranscriptionAudioManifestUseCase {
  constructor(
    private readonly configService: ConfigService,
    @Inject('IVideoProcessingService')
    private readonly videoProcessingService: IVideoProcessingService,
    @Inject('IMediaStorageService')
    private readonly mediaStorageService: IMediaStorageService,
    @Inject('ITempFileService')
    private readonly tempFileService: ITempFileService,
  ) {}

  async execute(input: {
    reelId: string;
    mediaAttemptId: string;
    inputPath: string;
    outputDir: string;
    storagePrefix: string;
    metadata: VideoMetadata;
    trim?: ReelMediaTrim;
  }): Promise<TranscriptionAudioManifestResult> {
    const format = this.getAudioFormat();
    const totalDurationMs = Math.max(
      0,
      input.trim?.outputDurationMs ?? input.metadata.durationMs ?? 0,
    );
    const plannedSegments = input.metadata.hasAudio
      ? this.planSegments(totalDurationMs, input.outputDir, format)
      : [];
    const extractionSegments = plannedSegments.map((segment) =>
      input.trim
        ? {
            ...segment,
            startMs: segment.startMs + input.trim.sourceStartMs,
            endMs: segment.endMs + input.trim.sourceStartMs,
          }
        : segment,
    );
    const extracted =
      extractionSegments.length > 0
        ? await this.videoProcessingService.extractTranscriptionAudioSegments(
            input.inputPath,
            extractionSegments,
            format,
          )
        : [];
    const artifactPrefix = `${input.storagePrefix.replace(/\/+$/, '')}/transcription/${input.mediaAttemptId}`;
    const artifacts: TranscriptionAudioArtifact[] = [];

    for (let index = 0; index < extracted.length; index += 1) {
      const segment = extracted[index];
      const plannedSegment = plannedSegments[index];
      const key = `${artifactPrefix}/audio_${index
        .toString()
        .padStart(6, '0')}.${format}`;
      const checksum = await this.tempFileService.getFileChecksum(
        segment.outputPath,
      );
      const uploaded = await this.mediaStorageService.uploadArtifact(
        segment.outputPath,
        key,
        format === 'flac' ? 'audio/flac' : 'audio/wav',
      );

      artifacts.push({
        key: uploaded.key,
        startMs: plannedSegment.startMs,
        endMs: plannedSegment.endMs,
        overlapBeforeMs: plannedSegment.overlapBeforeMs,
        checksum,
        byteLength: uploaded.byteLength,
      });
    }

    const manifest: TranscriptionAudioManifest = {
      reelId: input.reelId,
      mediaAttemptId: input.mediaAttemptId,
      totalDurationMs,
      format,
      artifacts,
      version: 1,
    };
    const manifestKey = `${artifactPrefix}/manifest.json`;
    const storedManifest = await this.mediaStorageService.uploadTextObject(
      manifestKey,
      JSON.stringify(manifest),
      'application/json',
    );

    return {
      manifest,
      manifestKey: storedManifest.key,
      manifestChecksum: storedManifest.checksum,
      totalAudioBytes: artifacts.reduce(
        (total, artifact) => total + artifact.byteLength,
        0,
      ),
    };
  }

  planSegments(
    totalDurationMs: number,
    outputDir: string,
    format: TranscriptionAudioFormat = this.getAudioFormat(),
  ): TranscriptionAudioSegmentRequest[] {
    if (!Number.isFinite(totalDurationMs) || totalDurationMs <= 0) {
      return [];
    }

    const segmentMs =
      this.getPositiveInt(
        'MEDIA_TRANSCRIPTION_SEGMENT_SECONDS',
        300,
        30,
        1800,
      ) * 1000;
    const configuredOverlapMs =
      this.getPositiveInt(
        'MEDIA_TRANSCRIPTION_SEGMENT_OVERLAP_SECONDS',
        2,
        0,
        30,
      ) * 1000;
    const overlapMs = Math.min(configuredOverlapMs, segmentMs - 1000);
    const segments: TranscriptionAudioSegmentRequest[] = [];

    for (
      let boundaryMs = 0;
      boundaryMs < totalDurationMs;
      boundaryMs += segmentMs
    ) {
      const startMs = Math.max(
        0,
        boundaryMs - (boundaryMs > 0 ? overlapMs : 0),
      );
      const endMs = Math.min(totalDurationMs, boundaryMs + segmentMs);
      const index = segments.length;

      segments.push({
        outputPath: path.join(
          outputDir,
          `audio_${index.toString().padStart(6, '0')}.${format}`,
        ),
        startMs,
        endMs,
        overlapBeforeMs: boundaryMs > 0 ? boundaryMs - startMs : 0,
      });
    }

    return segments;
  }

  private getAudioFormat(): TranscriptionAudioFormat {
    return this.configService
      .get<string>('MEDIA_TRANSCRIPTION_AUDIO_FORMAT')
      ?.trim()
      .toLowerCase() === 'flac'
      ? 'flac'
      : 'wav';
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
}
