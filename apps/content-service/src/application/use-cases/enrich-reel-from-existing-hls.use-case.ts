import { REEL_MEDIA_JOB_EVENT_TYPE } from '@common/processing/interfaces/reel-media-job.interface';
import {
  InvalidMediaFileError,
  ReelAlreadyProcessingError,
  ReelNotFoundError,
} from '@content/domain/errors/content.error';
import type { IOutboxDispatchTrigger } from '@content/domain/interfaces/outbox-dispatch-trigger.interface';
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { IContentRepository } from '../../domain/interfaces/content.repository.interface';
import type { IStorageService } from '../../domain/interfaces/storage.service.interface';
import { BuildReelMediaJobUseCase } from './build-reel-media-job.use-case';

const DEFAULT_STALE_PROCESSING_MS = 30 * 60 * 1000;

@Injectable()
export class EnrichReelFromExistingHlsUseCase {
  constructor(
    @Inject('IContentRepository')
    private readonly contentRepository: IContentRepository,
    @Inject('IStorageService')
    private readonly storageService: IStorageService,
    @Inject('IOutboxDispatchTrigger')
    private readonly outboxDispatchTrigger: IOutboxDispatchTrigger,
    private readonly buildReelMediaJobUseCase: BuildReelMediaJobUseCase,
  ) {}

  async execute(reelId: string): Promise<{
    queued: boolean;
    mediaAttemptId?: string;
    indexAttemptId?: string;
    reason?: 'ALREADY_ENRICHED';
  }> {
    const reel = await this.contentRepository.findById(reelId);
    if (!reel) throw new ReelNotFoundError();

    if (this.isActiveAndNotStale(reel)) {
      throw new ReelAlreadyProcessingError();
    }
    if (reel.mediaStatus !== 'COMPLETED' && reel.mediaStatus !== 'FAILED') {
      throw new InvalidMediaFileError(
        'Only completed or failed Reels can be enriched from existing HLS',
      );
    }

    const hlsMasterKey = reel.hlsMasterKey?.trim();
    if (!hlsMasterKey || !(await this.storageService.checkFileExists(hlsMasterKey))) {
      throw new InvalidMediaFileError(
        'The Reel does not have an available HLS master playlist',
      );
    }

    if (reel.transcriptionAudioManifestKey && reel.visualFrameManifestKey) {
      return { queued: false, reason: 'ALREADY_ENRICHED' };
    }

    const mediaAttemptId = randomUUID();
    const indexAttemptId = randomUUID();
    const baseJob = this.buildReelMediaJobUseCase.execute({
      reelId: reel.id,
      userId: reel.userId,
      mediaKey: reel.mediaKey,
      mediaAttemptId,
      clientObservedDurationMs: reel.outputDurationMs ?? reel.sourceDurationMs,
      title: reel.title,
      description: reel.description,
      tags: reel.tags,
    });
    const mediaJob = {
      ...baseJob,
      sourceMode: 'EXISTING_HLS' as const,
      hlsMasterKey,
      ...(reel.sourceOrientation
        ? { existingSourceOrientation: reel.sourceOrientation }
        : {}),
      ...(reel.sourceLengthClass
        ? { existingSourceLengthClass: reel.sourceLengthClass }
        : {}),
      ...(reel.mediaOutput?.checksums?.sourceSha256 && reel.sourceDurationMs
        ? { preservedSourceDurationMs: reel.sourceDurationMs }
        : {}),
    };

    await this.contentRepository.queueReelProcessingAttemptWithMediaJob(
      reel.id,
      mediaAttemptId,
      indexAttemptId,
      {
        id: mediaJob.jobId,
        eventType: REEL_MEDIA_JOB_EVENT_TYPE,
        payload: mediaJob,
        createdAt: new Date(mediaJob.createdAt),
      },
    );
    this.outboxDispatchTrigger.trigger();

    return { queued: true, mediaAttemptId, indexAttemptId };
  }

  private isActiveAndNotStale(reel: {
    mediaStatus: string;
    processingStartedAt?: Date;
    updatedAt?: Date;
    createdAt?: Date;
  }): boolean {
    if (reel.mediaStatus !== 'PENDING' && reel.mediaStatus !== 'PROCESSING') {
      return false;
    }
    const anchor = reel.processingStartedAt ?? reel.updatedAt ?? reel.createdAt;
    return Boolean(
      anchor && Date.now() - anchor.getTime() < DEFAULT_STALE_PROCESSING_MS,
    );
  }
}
