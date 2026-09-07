import {
  REEL_MEDIA_JOB_SCHEMA_VERSION,
  ReelMediaJob,
} from '@common/processing/interfaces/reel-media-job.interface';
import type { ReelMediaEdit } from '@common/content/schemas/reel-edit.schema';
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ClassifyReelJobLengthUseCase } from './classify-reel-job-length.use-case';

@Injectable()
export class BuildReelMediaJobUseCase {
  constructor(
    private readonly classifyReelJobLengthUseCase: ClassifyReelJobLengthUseCase,
  ) {}

  execute(input: {
    reelId: string;
    userId: string;
    mediaKey: string;
    mediaAttemptId: string;
    clientObservedDurationMs?: number;
    title?: string;
    description?: string;
    tags?: string[];
    edit?: ReelMediaEdit;
  }): ReelMediaJob {
    return {
      jobId: randomUUID(),
      reelId: input.reelId,
      userId: input.userId,
      mediaKey: input.mediaKey,
      mediaAttemptId: input.mediaAttemptId,
      expectedLengthClass: this.classifyReelJobLengthUseCase.execute(
        input.clientObservedDurationMs,
      ),
      ...(input.title ? { title: input.title } : {}),
      ...(input.description ? { description: input.description } : {}),
      tags: input.tags ?? [],
      ...(input.edit ? { edit: input.edit } : {}),
      createdAt: new Date().toISOString(),
      schemaVersion: REEL_MEDIA_JOB_SCHEMA_VERSION,
    };
  }
}
