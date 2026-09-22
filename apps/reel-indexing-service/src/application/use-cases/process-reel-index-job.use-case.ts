import type { ReelIndexJob } from '@common/processing/interfaces/reel-index-job.interface';
import type { IIndexingContentService } from '@indexing/domain/interfaces/content-service.interface';
import type { IIndexCheckpointRepository } from '@indexing/domain/interfaces/index-checkpoint.repository.interface';
import type { IReelIndexWorkflow } from '@indexing/domain/interfaces/reel-index-workflow.interface';
import type { ISemanticCandidateLifecycle } from '@indexing/domain/interfaces/semantic-candidate-lifecycle.interface';
import { Inject, Injectable, Logger } from '@nestjs/common';

export type ProcessReelIndexJobResult =
  | { status: 'COMPLETED' | 'DUPLICATE' | 'STALE' }
  | { status: 'RETRY' | 'PERMANENT_FAILURE'; error: string };

@Injectable()
export class ProcessReelIndexJobUseCase {
  private readonly logger = new Logger(ProcessReelIndexJobUseCase.name);

  constructor(
    @Inject('IReelIndexWorkflow')
    private readonly workflow: IReelIndexWorkflow,
    @Inject('IIndexCheckpointRepository')
    private readonly checkpoints: IIndexCheckpointRepository,
    @Inject('IIndexingContentService')
    private readonly content: IIndexingContentService,
    @Inject('ISemanticCandidateLifecycle')
    private readonly candidateLifecycle: ISemanticCandidateLifecycle,
  ) {}

  async execute(input: {
    job: ReelIndexJob;
    allowReclaim: boolean;
    allowRetry: boolean;
    retryNumber?: number;
    queuedAt?: string;
  }): Promise<ProcessReelIndexJobResult> {
    try {
      const status = await this.workflow.execute({
        job: input.job,
        allowReclaim: input.allowReclaim,
        retryNumber: input.retryNumber,
        queuedAt: input.queuedAt,
      });
      return { status };
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`Index job ${input.job.jobId} failed: ${detail}`);
      await this.checkpoints
        .fail(input.job.indexAttemptId, detail)
        .catch(() => undefined);

      // Safe for pre-commit failures: only inactive candidate rows are removed.
      // Commit-node failures perform their own reversible activation rollback.
      await this.candidateLifecycle
        .discardCandidate({
          reelId: input.job.reelId,
          indexAttemptId: input.job.indexAttemptId,
        })
        .catch(() => undefined);

      if (input.allowRetry) return { status: 'RETRY', error: detail };

      await this.content
        .failIndexing({
          reelId: input.job.reelId,
          indexAttemptId: input.job.indexAttemptId,
          errorDetail: detail,
        })
        .catch(() => undefined);
      return { status: 'PERMANENT_FAILURE', error: detail };
    }
  }
}
