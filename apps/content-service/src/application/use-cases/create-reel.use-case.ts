import { CreateReelDto } from '@common/content/dtos/create-reel.dto';
import { fingerprintCreateReelRequest } from '@common/content/publish-request-fingerprint';
import {
  isUserOwnedReelMediaKey,
  normalizeReelMediaKey,
} from '@common/content/reel-media-key';
import { REEL_MEDIA_JOB_EVENT_TYPE } from '@common/processing/interfaces/reel-media-job.interface';
import {
  InvalidMediaFileError,
  ReelPublishIntentConflictError,
} from '@content/domain/errors/content.error';
import type { Reel } from '@content/domain/entities/reel.entity';
import type { IOutboxDispatchTrigger } from '@content/domain/interfaces/outbox-dispatch-trigger.interface';
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { IContentRepository } from '../../domain/interfaces/content.repository.interface';
import type { IStorageService } from '../../domain/interfaces/storage.service.interface';
import { BuildReelMediaJobUseCase } from './build-reel-media-job.use-case';

@Injectable()
export class CreateReelUseCase {
  constructor(
    @Inject('IContentRepository')
    private readonly contentRepository: IContentRepository,
    @Inject('IStorageService')
    private readonly storageService: IStorageService,
    @Inject('IOutboxDispatchTrigger')
    private readonly outboxDispatchTrigger: IOutboxDispatchTrigger,
    private readonly buildReelMediaJobUseCase: BuildReelMediaJobUseCase,
  ) {}

  async execute(userId: string, payload: CreateReelDto) {
    const publishIntentId = payload.publishIntentId ?? randomUUID();
    const publishRequestFingerprint = fingerprintCreateReelRequest(payload);
    const mediaKey = normalizeReelMediaKey(payload.mediaKey);
    const existing = await this.findByPublishIntentId(userId, publishIntentId);

    if (existing) {
      return this.reconcileReplay(existing, publishRequestFingerprint);
    }

    if (!isUserOwnedReelMediaKey(mediaKey, userId)) {
      throw new InvalidMediaFileError();
    }

    const fileExists = await this.storageService.checkFileExists(mediaKey);

    if (!fileExists) {
      throw new InvalidMediaFileError();
    }

    const reelId = randomUUID();
    const mediaAttemptId = randomUUID();
    const indexAttemptId = randomUUID();
    const mediaJob = this.buildReelMediaJobUseCase.execute({
      reelId,
      userId,
      mediaKey,
      mediaAttemptId,
      clientObservedDurationMs: payload.clientObservedDurationMs,
      title: payload.title,
      description: payload.description,
      tags: payload.tags,
      edit: payload.edit,
    });

    try {
      const reel = await this.contentRepository.createReelWithMediaJob(
        {
          id: reelId,
          userId,
          publishIntentId,
          publishRequestFingerprint,
          mediaKey,
          title: payload.title,
          description: payload.description,
          tags: payload.tags,
          visibility: payload.visibility,
          status: 'PENDING',
          mediaStatus: 'PENDING',
          indexStatus: 'NOT_REQUESTED',
          processingStage: 'QUEUED',
          processingMessage: 'Queued for processing',
          processingProgress: 0,
          processingAttemptId: mediaAttemptId,
          mediaAttemptId,
          indexAttemptId,
          mediaEdit: payload.edit,
        },
        {
          id: mediaJob.jobId,
          eventType: REEL_MEDIA_JOB_EVENT_TYPE,
          payload: mediaJob,
          createdAt: new Date(mediaJob.createdAt),
        },
      );

      this.outboxDispatchTrigger.trigger();
      return reel;
    } catch (error: unknown) {
      if ((error as { code?: string })?.code !== 'P2002') {
        throw error;
      }

      const concurrent = await this.findByPublishIntentId(
        userId,
        publishIntentId,
      );
      if (!concurrent) throw error;
      return this.reconcileReplay(concurrent, publishRequestFingerprint);
    }
  }

  private async findByPublishIntentId(
    userId: string,
    publishIntentId: string,
  ): Promise<Reel | null> {
    return this.contentRepository.findByPublishIntentId(
      userId,
      publishIntentId,
    );
  }

  private reconcileReplay(
    existing: Reel,
    publishRequestFingerprint: string,
  ): Reel {
    if (
      existing.publishRequestFingerprint &&
      existing.publishRequestFingerprint !== publishRequestFingerprint
    ) {
      throw new ReelPublishIntentConflictError();
    }

    return existing;
  }
}
