import type { ReelIndexJob } from '@common/processing/interfaces/reel-index-job.interface';
import type { VisualSceneEvidence } from '@common/processing/interfaces/visual-scene-evidence.interface';
import type { IIndexingAiService } from '@indexing/domain/interfaces/ai-service.interface';
import type { IArtifactStorage } from '@indexing/domain/interfaces/artifact-storage.interface';
import type { IIndexingApplicationConfig } from '@indexing/domain/interfaces/indexing-application-config.interface';
import { Inject, Injectable, Logger } from '@nestjs/common';

@Injectable()
export class AnalyzeVisualFrameManifestUseCase {
  private readonly logger = new Logger(AnalyzeVisualFrameManifestUseCase.name);

  constructor(
    @Inject('IIndexingApplicationConfig')
    private readonly config: IIndexingApplicationConfig,
    @Inject('IArtifactStorage') private readonly storage: IArtifactStorage,
    @Inject('IIndexingAiService') private readonly ai: IIndexingAiService,
  ) {}

  async execute(job: ReelIndexJob): Promise<VisualSceneEvidence[]> {
    const required = job.requireVisualAnalysis ?? this.required();
    if (!this.enabled()) {
      if (required) throw new Error('Visual analysis is disabled for this index job');
      return [];
    }
    if (required && !job.visualFrameManifestKey) {
      throw new Error('Required visual frame manifest key is missing');
    }

    const manifestKey =
      job.visualFrameManifestKey ?? this.deriveManifestKey(job);
    if (!(await this.storage.artifactExists(manifestKey))) {
      if (required) {
        throw new Error('Required visual frame manifest is unavailable');
      }
      this.logger.debug(
        `[VisualIndex] no visual frame manifest reelId=${job.reelId}`,
      );
      return [];
    }

    const manifest = await this.storage.getVisualFrameManifest(manifestKey);
    if (
      manifest.reelId !== job.reelId ||
      manifest.mediaAttemptId !== job.mediaAttemptId
    ) {
      throw new Error('Visual frame manifest does not match the index job');
    }

    if (manifest.artifacts.length === 0 && required) {
      throw new Error('Visual frame manifest contains no sampled frames');
    }

    const results = new Array<VisualSceneEvidence>(manifest.artifacts.length);
    const failures: string[] = [];
    await this.mapWithConcurrency(
      manifest.artifacts,
      this.getPositiveInt('INDEX_VISUAL_ANALYSIS_CONCURRENCY', 2, 1, 8),
      async (artifact, index) => {
        try {
          const imageBytes = await this.storage.getVerifiedArtifactBytes({
            key: artifact.key,
            sha256: artifact.checksum,
          });

          const analysis = await this.ai.analyzeVisualFrame({
            imageBytes,
            mimeType: 'image/jpeg',
            timestampMs: artifact.timestampMs,
          });

          results[index] = {
            frameKey: artifact.key,
            frameChecksum: artifact.checksum,
            timestampMs: artifact.timestampMs,
            reason: artifact.reason,
            caption: analysis.caption,
            ocrText: analysis.ocrText,
            objects: analysis.objects,
            provider: analysis.provider,
            model: analysis.model,
            version: analysis.version,
          };
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);
          failures.push(`${artifact.timestampMs}ms: ${message}`);
          this.logger.warn(
            `[VisualIndex] frame analysis skipped reelId=${job.reelId} timestampMs=${artifact.timestampMs}: ${message}`,
          );
        }
      },
    );

    if (failures.length > 0 && required) {
      throw new Error(
        `Visual analysis failed for ${failures.length}/${manifest.artifacts.length} sampled frames: ${failures.slice(0, 3).join('; ')}`,
      );
    }

    const completed = results.filter((result): result is VisualSceneEvidence =>
      Boolean(result),
    );
    this.logger.log(
      `[VisualIndex] reelId=${job.reelId} completed=${completed.length} failed=${failures.length} sampled=${manifest.artifacts.length}`,
    );
    return completed;
  }

  private deriveManifestKey(job: ReelIndexJob): string {
    const prefix = job.mediaKey.replace(/\.[^.]+$/, '').replace(/\/+$/, '');
    return `${prefix}/visual/${job.mediaAttemptId}/manifest.json`;
  }

  private enabled(): boolean {
    return this.boolean('INDEX_VISUAL_ANALYSIS_ENABLED', true);
  }

  private required(): boolean {
    return this.boolean('INDEX_VISUAL_ANALYSIS_REQUIRED', false);
  }

  private boolean(key: string, fallback: boolean): boolean {
    const value = this.config.get<string>(key)?.trim().toLowerCase();
    if (value === undefined) return fallback;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return fallback;
  }

  private async mapWithConcurrency<T>(
    values: T[],
    concurrency: number,
    handler: (value: T, index: number) => Promise<void>,
  ): Promise<void> {
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(concurrency, values.length) },
      async () => {
        while (cursor < values.length) {
          const index = cursor;
          cursor += 1;
          await handler(values[index], index);
        }
      },
    );
    await Promise.all(workers);
  }

  private getPositiveInt(
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const parsed = Number(this.config.get<string>(key) ?? fallback);
    return Number.isFinite(parsed)
      ? Math.min(max, Math.max(min, Math.round(parsed)))
      : fallback;
  }
}
