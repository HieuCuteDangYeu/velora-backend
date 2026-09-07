import type { VisualFrameManifest } from '@common/processing/interfaces/visual-frame-manifest.interface';
import type { ReelPixelCrop } from '@common/processing/reel-media-crop';
import type { ReelMediaTrim } from '@common/processing/reel-media-trim';
import type { IMediaStorageService } from '@processing/domain/interfaces/media-storage.service.interface';
import type { ITempFileService } from '@processing/domain/interfaces/temp-file.service.interface';
import type {
  ExtractedVisualFrame,
  IVisualFrameExtractionService,
} from '@processing/domain/interfaces/visual-frame-extraction.service.interface';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type SelectedVisualFrame = Omit<ExtractedVisualFrame, 'reason'> & {
  reason: VisualFrameManifest['artifacts'][number]['reason'];
};

export interface VisualFrameManifestResult {
  manifest: VisualFrameManifest;
  manifestKey: string;
  manifestChecksum: string;
  totalFrameBytes: number;
}

@Injectable()
export class BuildVisualFrameManifestUseCase {
  constructor(
    private readonly configService: ConfigService,
    @Inject('IVisualFrameExtractionService')
    private readonly visualFrameExtractionService: IVisualFrameExtractionService,
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
    metadata: { durationMs?: number };
    crop?: ReelPixelCrop;
    trim?: ReelMediaTrim;
  }): Promise<VisualFrameManifestResult> {
    const totalDurationMs = Math.max(0, input.metadata.durationMs ?? 0);
    const periodicIntervalMs =
      this.getPositiveInt('MEDIA_VISUAL_PERIODIC_INTERVAL_SECONDS', 4, 1, 30) *
      1000;
    const sceneThreshold = this.getNumber(
      'MEDIA_VISUAL_SCENE_THRESHOLD',
      0.35,
      0.05,
      0.95,
    );
    const dedupeWindowMs = this.getPositiveInt(
      'MEDIA_VISUAL_DEDUPE_WINDOW_MS',
      750,
      0,
      10_000,
    );
    const maxFrames = this.getPositiveInt(
      'MEDIA_VISUAL_MAX_FRAMES',
      24,
      1,
      120,
    );
    const candidates =
      totalDurationMs > 0
        ? await this.visualFrameExtractionService.extractCandidateFrames({
            inputPath: input.inputPath,
            outputDir: input.outputDir,
            totalDurationMs,
            periodicIntervalMs,
            sceneThreshold,
            crop: input.crop,
            trim: input.trim,
          })
        : [];
    const selected = this.limitFrames(
      this.dedupeFrames(candidates, dedupeWindowMs),
      maxFrames,
    );
    const artifactPrefix = `${input.storagePrefix.replace(/\/+$/, '')}/visual/${input.mediaAttemptId}`;
    const artifacts: VisualFrameManifest['artifacts'] = [];

    for (let index = 0; index < selected.length; index += 1) {
      const frame = selected[index];
      const key = `${artifactPrefix}/frame_${index
        .toString()
        .padStart(6, '0')}.jpg`;
      const checksum = await this.tempFileService.getFileChecksum(
        frame.outputPath,
      );
      const uploaded = await this.mediaStorageService.uploadArtifact(
        frame.outputPath,
        key,
        'image/jpeg',
      );

      artifacts.push({
        key: uploaded.key,
        timestampMs: frame.timestampMs,
        checksum,
        byteLength: uploaded.byteLength,
        reason: frame.reason,
      });
    }

    const manifest: VisualFrameManifest = {
      reelId: input.reelId,
      mediaAttemptId: input.mediaAttemptId,
      totalDurationMs,
      sampling: {
        periodicIntervalMs,
        sceneThreshold,
        dedupeWindowMs,
        maxFrames,
      },
      artifacts,
      version: 1,
    };
    const manifestKey = `${artifactPrefix}/manifest.json`;
    const stored = await this.mediaStorageService.uploadTextObject(
      manifestKey,
      JSON.stringify(manifest),
      'application/json',
    );

    return {
      manifest,
      manifestKey: stored.key,
      manifestChecksum: stored.checksum,
      totalFrameBytes: artifacts.reduce(
        (total, artifact) => total + artifact.byteLength,
        0,
      ),
    };
  }

  private dedupeFrames(
    candidates: ExtractedVisualFrame[],
    dedupeWindowMs: number,
  ): SelectedVisualFrame[] {
    const ordered = [...candidates].sort(
      (left, right) => left.timestampMs - right.timestampMs,
    );
    const selected: SelectedVisualFrame[] = [];

    for (const candidate of ordered) {
      const previous = selected.at(-1);
      if (
        previous &&
        Math.abs(candidate.timestampMs - previous.timestampMs) <= dedupeWindowMs
      ) {
        const shouldPreferSceneFrame =
          candidate.reason === 'SCENE_CHANGE' && previous.reason === 'PERIODIC';
        if (previous.reason !== candidate.reason) {
          previous.reason = 'PERIODIC_AND_SCENE_CHANGE';
        }
        if (shouldPreferSceneFrame) {
          previous.outputPath = candidate.outputPath;
          previous.timestampMs = candidate.timestampMs;
        }
        continue;
      }

      selected.push({ ...candidate });
    }

    return selected;
  }

  private limitFrames<T>(frames: T[], maxFrames: number): T[] {
    if (frames.length <= maxFrames) return frames;
    if (maxFrames === 1) return [frames[0]];

    const selected: T[] = [];
    const seen = new Set<number>();
    for (let index = 0; index < maxFrames; index += 1) {
      const sourceIndex = Math.round(
        (index * (frames.length - 1)) / (maxFrames - 1),
      );
      if (!seen.has(sourceIndex)) {
        selected.push(frames[sourceIndex]);
        seen.add(sourceIndex);
      }
    }
    return selected;
  }

  private getPositiveInt(
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    return Math.round(this.getNumber(key, fallback, min, max));
  }

  private getNumber(
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const value = Number(this.configService.get<string>(key) ?? fallback);
    return Number.isFinite(value)
      ? Math.min(max, Math.max(min, value))
      : fallback;
  }
}
