import { REEL_MEDIA_JOB_EVENT_TYPE } from '@common/processing/interfaces/reel-media-job.interface';
import {
  InvalidMediaFileError,
  ReelAlreadyProcessingError,
  ReelNotFoundError,
  ReelReprocessForbiddenError,
} from '@content/domain/errors/content.error';
import type { IOutboxDispatchTrigger } from '@content/domain/interfaces/outbox-dispatch-trigger.interface';
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Reel } from '../../domain/entities/reel.entity';
import type { IContentRepository } from '../../domain/interfaces/content.repository.interface';
import type { IStorageService } from '../../domain/interfaces/storage.service.interface';
import { BuildReelMediaJobUseCase } from './build-reel-media-job.use-case';

const DEFAULT_STALE_PROCESSING_MS = 30 * 60 * 1000;

@Injectable()
export class ReprocessReelUseCase {
  constructor(
    @Inject('IContentRepository')
    private readonly contentRepository: IContentRepository,
    @Inject('IStorageService')
    private readonly storageService: IStorageService,
    @Inject('IOutboxDispatchTrigger')
    private readonly outboxDispatchTrigger: IOutboxDispatchTrigger,
    private readonly buildReelMediaJobUseCase: BuildReelMediaJobUseCase,
  ) {}

  async execute(reelId: string, userId: string, isAdmin = false) {
    const reel = await this.contentRepository.findById(reelId);

    if (!reel) {
      throw new ReelNotFoundError();
    }

    if (reel.userId !== userId && !isAdmin) {
      throw new ReelReprocessForbiddenError();
    }

    if (this.isActiveAndNotStale(reel)) {
      throw new ReelAlreadyProcessingError();
    }

    if (!reel.mediaKey?.trim()) {
      throw new InvalidMediaFileError();
    }

    const fileExists = await this.storageService.checkFileExists(reel.mediaKey);

    if (!fileExists) {
      throw new InvalidMediaFileError();
    }

    const mediaAttemptId = randomUUID();
    const indexAttemptId = randomUUID();
    const mediaJob = this.buildReelMediaJobUseCase.execute({
      reelId: reel.id,
      userId: reel.userId,
      mediaKey: reel.mediaKey,
      mediaAttemptId,
      clientObservedDurationMs: reel.outputDurationMs ?? reel.sourceDurationMs,
      title: reel.title,
      description: reel.description,
      tags: reel.tags,
      edit: reel.mediaEdit,
    });

    const queuedReel =
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
    return queuedReel;
  }

  private isActiveAndNotStale(reel: Reel): boolean {
    if (reel.status !== 'PENDING' && reel.status !== 'PROCESSING') {
      return false;
    }

    const anchor =
      reel.processingStartedAt ?? reel.updatedAt ?? reel.createdAt ?? null;

    if (!anchor) {
      return false;
    }

    return Date.now() - anchor.getTime() < DEFAULT_STALE_PROCESSING_MS;
  }
}
