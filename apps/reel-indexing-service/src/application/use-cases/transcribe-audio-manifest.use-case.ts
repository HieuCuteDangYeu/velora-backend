import type { ReelIndexJob } from '@common/processing/interfaces/reel-index-job.interface';
import type { TranscriptionAudioManifest } from '@common/processing/interfaces/transcription-audio-manifest.interface';
import type { AudioSegmentCheckpoint } from '@indexing/domain/entities/index-checkpoint.entity';
import type { IIndexingAiService } from '@indexing/domain/interfaces/ai-service.interface';
import type { IArtifactStorage } from '@indexing/domain/interfaces/artifact-storage.interface';
import type { IIndexCheckpointRepository } from '@indexing/domain/interfaces/index-checkpoint.repository.interface';
import type { IIndexingApplicationConfig } from '@indexing/domain/interfaces/indexing-application-config.interface';
import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';

@Injectable()
export class TranscribeAudioManifestUseCase {
  constructor(
    @Inject('IIndexingApplicationConfig')
    private readonly config: IIndexingApplicationConfig,
    @Inject('IArtifactStorage') private readonly storage: IArtifactStorage,
    @Inject('IIndexingAiService') private readonly ai: IIndexingAiService,
    @Inject('IIndexCheckpointRepository')
    private readonly checkpoints: IIndexCheckpointRepository,
  ) {}

  async execute(job: ReelIndexJob): Promise<{
    manifest?: TranscriptionAudioManifest;
    segments: AudioSegmentCheckpoint[];
  }> {
    if (!job.transcriptionAudioManifestKey) return { segments: [] };

    const manifest = await this.storage.getTranscriptionAudioManifest(
      job.transcriptionAudioManifestKey,
    );
    if (
      manifest.reelId !== job.reelId ||
      manifest.mediaAttemptId !== job.mediaAttemptId
    ) {
      throw new Error(
        'Transcription audio manifest does not match the index job',
      );
    }

    await this.checkpoints.initializeAudioSegments(
      job.indexAttemptId,
      manifest.artifacts,
      this.transcriptionIdentity(manifest.artifacts),
    );
    const current = await this.checkpoints.listAudioSegments(
      job.indexAttemptId,
    );
    const pending = current.filter((segment) => segment.status !== 'COMPLETED');

    await this.mapWithConcurrency(
      pending,
      this.getPositiveInt('INDEX_TRANSCRIPTION_CONCURRENCY', 2, 1, 16),
      async (segment) => this.transcribeSegment(job, segment),
    );

    return {
      manifest,
      segments: await this.checkpoints.listAudioSegments(job.indexAttemptId),
    };
  }

  private transcriptionIdentity(
    artifacts: TranscriptionAudioManifest['artifacts'],
  ): string {
    const identity = this.config.transcriptionIdentity();
    return createHash('sha256')
      .update(
        JSON.stringify({
          artifactChecksums: artifacts.map((artifact) => artifact.checksum),
          ...identity,
        }),
      )
      .digest('hex');
  }

  private async transcribeSegment(
    job: ReelIndexJob,
    segment: AudioSegmentCheckpoint,
  ): Promise<void> {
    const maxAttempts = this.getPositiveInt(
      'INDEX_SEGMENT_MAX_ATTEMPTS',
      3,
      1,
      5,
    );
    let lastError = 'Segment transcription failed';

    for (
      let attempt = segment.attemptCount;
      attempt < maxAttempts;
      attempt += 1
    ) {
      await this.checkpoints.markAudioSegmentProcessing(
        job.indexAttemptId,
        segment.segmentNumber,
      );
      try {
        const result = await this.ai.transcribeAudioKey({
          audioKey: segment.artifactKey,
          initialPrompt: this.buildPrompt(job),
        });
        await this.checkpoints.completeAudioSegment({
          ...segment,
          status: 'COMPLETED',
          attemptCount: attempt + 1,
          transcriptText: result.text,
          transcriptSegments: result.segments,
          provider: result.provider ?? 'unknown',
          transcriptionModel: result.model ?? 'unknown',
          transcriptionVersion: result.version ?? job.indexVersion,
        });
        return;
      } catch (error: unknown) {
        lastError = this.describeError(error);
        await this.checkpoints.failAudioSegment({
          indexAttemptId: job.indexAttemptId,
          segmentNumber: segment.segmentNumber,
          error: lastError,
        });
      }
    }

    throw new Error(
      `Audio segment ${segment.segmentNumber} failed: ${lastError}`,
    );
  }

  // The English title, description and tags steer Whisper toward English: on
  // Chinese speech it replaced correct output with English gibberish, so the
  // prompt is opt-in. Set INDEX_TRANSCRIPTION_METADATA_PROMPT=true to send it.
  private buildPrompt(job: ReelIndexJob): string | undefined {
    if (
      this.config.get<string>('INDEX_TRANSCRIPTION_METADATA_PROMPT') !== 'true'
    ) {
      return undefined;
    }
    const values = [job.title, job.description, ...job.tags]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value));
    return values.length > 0 ? values.join('. ').slice(0, 1000) : undefined;
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (
      typeof error === 'object' &&
      error !== null &&
      'message' in error &&
      typeof error.message === 'string'
    ) {
      return error.message;
    }
    return String(error);
  }

  private async mapWithConcurrency<T>(
    values: T[],
    concurrency: number,
    handler: (value: T) => Promise<void>,
  ): Promise<void> {
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(concurrency, values.length) },
      async () => {
        while (cursor < values.length) {
          const index = cursor;
          cursor += 1;
          await handler(values[index]);
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
