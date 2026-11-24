import type { VisualFrameAnalysis } from '@common/ai/interfaces/visual-analysis.interface';
import type { ReelIndexJob } from '@common/processing/interfaces/reel-index-job.interface';
import type { VisualSceneEvidence } from '@common/processing/interfaces/visual-scene-evidence.interface';
import type { IIndexingAiService } from '@indexing/domain/interfaces/ai-service.interface';
import type { IArtifactStorage } from '@indexing/domain/interfaces/artifact-storage.interface';
import type { IIndexingApplicationConfig } from '@indexing/domain/interfaces/indexing-application-config.interface';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

// Frame analyses are cached by the frame's content hash, so a re-index, a retry or a re-queue of the
// same media analyses nothing twice. The key needs the reel-indexing/ prefix the artifact store enforces.
const CACHE_PREFIX = 'reel-indexing/visual-analysis-cache';

export function isVisualProviderRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b|daily free allocation|rate[- ]?limit|quota|too many requests/i.test(
    message,
  );
}

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
      if (required)
        throw new Error('Visual analysis is disabled for this index job');
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
    let cacheHits = 0;
    let providerRateLimitFailure: string | undefined;
    await this.mapWithConcurrency(
      manifest.artifacts,
      this.getPositiveInt('INDEX_VISUAL_ANALYSIS_CONCURRENCY', 2, 1, 8),
      async (artifact, index) => {
        if (providerRateLimitFailure) return;
        try {
          let analysis = await this.readCachedAnalysis(artifact.checksum);
          if (analysis) {
            cacheHits += 1;
          } else {
            const imageBytes = await this.storage.getVerifiedArtifactBytes({
              key: artifact.key,
              sha256: artifact.checksum,
            });

            analysis = await this.ai.analyzeVisualFrame({
              imageBytes,
              mimeType: 'image/jpeg',
              timestampMs: artifact.timestampMs,
            });
            await this.writeCachedAnalysis(artifact.checksum, analysis);
          }

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
          if (
            !providerRateLimitFailure &&
            isVisualProviderRateLimitError(error)
          ) {
            providerRateLimitFailure = message;
          }
          this.logger.warn(
            `[VisualIndex] frame analysis skipped reelId=${job.reelId} timestampMs=${artifact.timestampMs}: ${message}`,
          );
        }
      },
    );

    if (providerRateLimitFailure && required) {
      throw new Error(
        `Visual provider rate limit or quota exhausted; retry this index attempt later: ${providerRateLimitFailure}`,
      );
    }
    if (failures.length > 0 && required) {
      throw new Error(
        `Visual analysis failed for ${failures.length}/${manifest.artifacts.length} sampled frames: ${failures.slice(0, 3).join('; ')}`,
      );
    }

    const completed = results.filter((result): result is VisualSceneEvidence =>
      Boolean(result),
    );
    this.logger.log(
      `[VisualIndex] reelId=${job.reelId} completed=${completed.length} cached=${cacheHits} failed=${failures.length} sampled=${manifest.artifacts.length}`,
    );
    return completed;
  }

  private cacheKey(checksum: string): string | null {
    const hash = checksum.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) return null;
    const version = (
      this.config.get<string>('INDEX_VISUAL_CACHE_VERSION') ?? 'v1'
    )
      .trim()
      .replace(/[^A-Za-z0-9._-]/g, '_');
    return `${CACHE_PREFIX}/${version || 'v1'}/${hash}.json`;
  }

  /** A stored analysis for these exact frame bytes, or null. A cache problem is never an indexing failure. */
  private async readCachedAnalysis(
    checksum: string,
  ): Promise<VisualFrameAnalysis | null> {
    const key = this.cacheKey(checksum);
    if (!key || !this.boolean('INDEX_VISUAL_CACHE_ENABLED', true)) return null;
    try {
      if (!(await this.storage.artifactExists(key))) return null;
      const value = JSON.parse(
        Buffer.from(await this.storage.getArtifactBytes(key)).toString('utf8'),
      ) as Partial<VisualFrameAnalysis>;
      const text = (field: unknown) =>
        typeof field === 'string' && field.trim().length > 0;
      if (
        !text(value.caption) ||
        !Array.isArray(value.objects) ||
        !value.objects.every((item) => typeof item === 'string') ||
        !text(value.provider) ||
        !text(value.model) ||
        !text(value.version)
      )
        return null;
      return {
        caption: value.caption as string,
        ...(typeof value.ocrText === 'string' && value.ocrText
          ? { ocrText: value.ocrText }
          : {}),
        objects: value.objects,
        provider: value.provider as string,
        model: value.model as string,
        version: value.version as string,
      };
    } catch (error: unknown) {
      this.logger.debug(
        `[VisualIndex] cache read skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async writeCachedAnalysis(
    checksum: string,
    analysis: VisualFrameAnalysis,
  ): Promise<void> {
    const key = this.cacheKey(checksum);
    if (!key || !this.boolean('INDEX_VISUAL_CACHE_ENABLED', true)) return;
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(analysis));
      await this.storage.putVerifiedArtifact({
        key,
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    } catch (error: unknown) {
      this.logger.debug(
        `[VisualIndex] cache write skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
