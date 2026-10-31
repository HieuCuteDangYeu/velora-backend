import type { CompleteReelIndexCommand } from '@common/processing/interfaces/complete-reel-index.interface';
import type { ReelIndexJob } from '@common/processing/interfaces/reel-index-job.interface';
import type { IIndexingContentService } from '@indexing/domain/interfaces/content-service.interface';
import type {
  ISemanticCandidateLifecycle,
  SemanticCandidateActivation,
} from '@indexing/domain/interfaces/semantic-candidate-lifecycle.interface';
import {
  ProjectionPendingError,
  ProjectionSupersededError,
  type ISemanticPublication,
} from '@indexing/domain/interfaces/reel-vector-store.interface';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

export type SemanticCandidateCommitStatus = 'COMPLETED' | 'STALE';

@Injectable()
export class CommitSemanticCandidateUseCase {
  private readonly logger = new Logger(CommitSemanticCandidateUseCase.name);

  constructor(
    @Inject('IIndexingContentService')
    private readonly content: IIndexingContentService,
    @Inject('ISemanticCandidateLifecycle')
    private readonly lifecycle: ISemanticCandidateLifecycle,
    @Optional()
    @Inject('ISemanticPublication')
    private readonly publication?: ISemanticPublication,
  ) {}

  async execute(input: {
    job: ReelIndexJob;
    completion: CompleteReelIndexCommand;
    projectionGeneration?: string;
    publicationToken?: string;
  }): Promise<SemanticCandidateCommitStatus> {
    const publication = await this.publication?.defer(input);
    const identity = {
      reelId: input.job.reelId,
      indexAttemptId: input.job.indexAttemptId,
      ...((publication?.generation ?? input.projectionGeneration)
        ? {
            projectionGeneration:
              publication?.generation ?? input.projectionGeneration,
          }
        : {}),
      ...(publication?.token ? { publicationToken: publication.token } : {}),
    };
    let activation: SemanticCandidateActivation | undefined;
    let readyToFinalize = false;
    try {
      if (publication?.pending) throw new ProjectionPendingError();
      const current = await this.content.isIndexingAttemptCurrent({
        reelId: identity.reelId,
        indexAttemptId: identity.indexAttemptId,
      });
      const active =
        identity.projectionGeneration &&
        (await this.lifecycle.isCandidateActive?.({
          ...identity,
          projectionGeneration: identity.projectionGeneration,
        }));
      const recovering = publication?.recovering || active;
      if (!current && !recovering) {
        await this.lifecycle.discardCandidate(identity);
        return 'STALE';
      }
      if (current)
        activation = await this.lifecycle.activateCandidate(identity);
      const applied = await this.content.completeIndexing(input.completion);
      if (!applied) {
        await this.lifecycle.rollbackCandidate({
          ...identity,
          previousIndexAttemptId: activation?.previousIndexAttemptId,
        });
        await this.lifecycle.discardCandidate(identity);
        return 'STALE';
      }
      // Content completion is idempotent for accepted COMPLETED/DEGRADED attempts.
      // A compensated RPC with a lost acknowledgement may need activation restored.
      if (!current && !active)
        activation = await this.lifecycle.activateCandidate(identity);
      readyToFinalize = true;
    } catch (error: unknown) {
      if (
        error instanceof ProjectionPendingError ||
        error instanceof ProjectionSupersededError
      )
        throw error;
      await this.lifecycle
        .rollbackCandidate({
          ...identity,
          previousIndexAttemptId: activation?.previousIndexAttemptId,
        })
        .catch((rollbackError: unknown) => {
          this.logger.error(
            `[SemanticCommit] rollback failed: ${String(rollbackError)}`,
          );
        });
      if (publication?.token) {
        // The journal owns recovery; generic job failure must not discard it.
        this.logger.warn('semantic_publication_recovery_pending');
        throw new ProjectionPendingError();
      }
      throw error;
    } finally {
      // Finalization below still requires ownership; release only on failed/stale paths.
      if (
        !readyToFinalize &&
        publication?.token &&
        identity.projectionGeneration
      )
        await this.releasePublication(
          identity.reelId,
          identity.indexAttemptId,
          identity.projectionGeneration,
          publication.token,
        );
    }

    try {
      await this.lifecycle.finalizeCandidate(identity);
      if (publication?.token)
        await this.publication?.complete(
          identity.reelId,
          identity.indexAttemptId,
          identity.projectionGeneration,
          publication.token,
        );
      else
        await this.publication?.complete(
          identity.reelId,
          identity.indexAttemptId,
          identity.projectionGeneration,
        );
    } catch (error: unknown) {
      this.logger.error(
        `[SemanticCommit] post-commit cleanup failed for ${input.job.indexAttemptId}: ${String(error)}`,
      );
    } finally {
      if (publication?.token && identity.projectionGeneration)
        await this.releasePublication(
          identity.reelId,
          identity.indexAttemptId,
          identity.projectionGeneration,
          publication.token,
        );
    }
    return 'COMPLETED';
  }

  private async releasePublication(
    reelId: string,
    attempt: string,
    generation: string,
    token: string,
  ): Promise<void> {
    try {
      await this.publication?.release?.(reelId, attempt, generation, token);
    } catch {
      // The durable lease expires; never turn accepted work into a generic job failure.
      this.logger.warn('semantic_publication_release_pending');
    }
  }
}
