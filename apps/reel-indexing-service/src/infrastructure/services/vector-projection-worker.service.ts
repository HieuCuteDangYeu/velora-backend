import { CommitSemanticCandidateUseCase } from '@indexing/application/use-cases/commit-semantic-candidate.use-case';
import { ProjectionPendingError } from '@indexing/domain/interfaces/reel-vector-store.interface';
import {
  PrismaVectorProjectionRepository,
  type ProjectionContinuation,
} from '@indexing/infrastructure/repositories/prisma-vector-projection.repository';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

@Injectable()
export class VectorProjectionWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VectorProjectionWorker.name);
  private timer?: NodeJS.Timeout;
  private busy = false;
  constructor(
    private readonly projections: PrismaVectorProjectionRepository,
    private readonly commit: CommitSemanticCandidateUseCase,
  ) {}
  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, 1000);
    this.timer.unref();
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.projections.enabled) await this.projections.reconcile();
      const task = this.projections.enabled
        ? await this.projections.claim()
        : undefined;
      if (task) {
        try {
          await this.projections.apply(task);
        } catch {
          await this.projections.retry(task);
          this.logger.warn('vector_projection_retry');
        }
      }
      const continuation = await this.projections.claimContinuation();
      if (continuation) {
        try {
          await this.commit.execute({
            ...(continuation.continuation as unknown as ProjectionContinuation),
            publicationToken: continuation.continuationToken!,
          });
        } catch (error) {
          if (!(error instanceof ProjectionPendingError))
            this.logger.warn('vector_publication_retry');
        } finally {
          await this.projections.release(
            continuation.reelId,
            continuation.indexAttemptId,
            continuation.generation.toString(),
            continuation.continuationToken!,
          );
        }
      }
    } catch {
      this.logger.warn('vector_projection_worker_unavailable');
    } finally {
      this.busy = false;
    }
  }
}
