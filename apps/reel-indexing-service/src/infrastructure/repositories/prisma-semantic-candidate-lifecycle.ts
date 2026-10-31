import type {
  ISemanticCandidateLifecycle,
  SemanticCandidateActivation,
} from '@indexing/domain/interfaces/semantic-candidate-lifecycle.interface';
import { PrismaService } from '@indexing/infrastructure/prisma/prisma.service';
import { ProjectionSupersededError } from '@indexing/domain/interfaces/reel-vector-store.interface';
import { PrismaVectorProjectionRepository } from './prisma-vector-projection.repository';
import { Injectable, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/reel-indexing-client';

@Injectable()
export class PrismaSemanticCandidateLifecycle implements ISemanticCandidateLifecycle {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly projections?: PrismaVectorProjectionRepository,
  ) {}

  async isCandidateActive(input: {
    reelId: string;
    indexAttemptId: string;
    projectionGeneration: string;
    publicationToken?: string;
  }): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.reelId}))`;
      return (
        (await this.matchesGeneration(tx, input)) &&
        (await tx.reelDocument.count({
          where: {
            reelId: input.reelId,
            indexAttemptId: input.indexAttemptId,
            isActive: true,
          },
        })) === 1
      );
    });
  }
  async activateCandidate(input: {
    reelId: string;
    indexAttemptId: string;
    projectionGeneration?: string;
    publicationToken?: string;
  }): Promise<SemanticCandidateActivation> {
    return await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.reelId}))`;

      if (!(await this.matchesGeneration(transaction, input)))
        throw new ProjectionSupersededError();
      await this.projections?.assertOwner(transaction, input);
      const journal = await this.journal(transaction, input);
      const active = await transaction.reelDocument.findFirst({
        where: { reelId: input.reelId, isActive: true },
        select: { indexAttemptId: true },
      });
      const activeProjection =
        active &&
        (await this.journal(transaction, {
          reelId: input.reelId,
          indexAttemptId: active.indexAttemptId,
        }));
      if (
        journal &&
        activeProjection &&
        activeProjection.generation > journal.generation
      )
        throw new ProjectionSupersededError();
      if (
        journal &&
        journal.publicationPhase !== 'STAGED' &&
        active?.indexAttemptId === input.indexAttemptId
      ) {
        return {
          previousIndexAttemptId: journal.previousIndexAttemptId ?? undefined,
          projectionGeneration: journal.generation.toString(),
        };
      }
      if (
        journal &&
        (journal.publicationPhase === 'ACTIVATED' ||
          journal.publicationPhase === 'FINALIZED')
      )
        throw new ProjectionSupersededError();
      const projectionGeneration = await this.projections?.assertReady(
        transaction,
        input.reelId,
        input.indexAttemptId,
      );
      const previousIndexAttemptId =
        journal?.publicationPhase === 'COMPENSATED'
          ? (journal.previousIndexAttemptId ?? undefined)
          : activeProjection?.publicationPhase === 'ACTIVATED'
            ? (activeProjection.previousIndexAttemptId ?? undefined)
            : active?.indexAttemptId;
      const previousGeneration =
        journal?.publicationPhase === 'COMPENSATED'
          ? journal.previousGeneration
          : activeProjection?.publicationPhase === 'ACTIVATED'
            ? activeProjection.previousGeneration
            : activeProjection?.generation;
      if (journal)
        await transaction.vectorProjection.update({
          where: {
            reelId_generation: {
              reelId: journal.reelId,
              generation: journal.generation,
            },
          },
          data: {
            previousIndexAttemptId,
            previousGeneration,
            publicationPhase: 'ACTIVATED',
          },
        });

      await this.setActive(transaction, input.reelId, undefined, false);
      const activated = await transaction.reelDocument.updateMany({
        where: {
          reelId: input.reelId,
          indexAttemptId: input.indexAttemptId,
        },
        data: { isActive: true },
      });
      if (activated.count !== 1) {
        throw new Error(
          `Semantic candidate ${input.indexAttemptId} is missing`,
        );
      }

      await transaction.reelSection.updateMany({
        where: {
          reelId: input.reelId,
          indexAttemptId: input.indexAttemptId,
        },
        data: { isActive: true },
      });
      await transaction.reelChunk.updateMany({
        where: {
          reelId: input.reelId,
          indexAttemptId: input.indexAttemptId,
        },
        data: { isActive: true },
      });
      await transaction.reelVisualScene.updateMany({
        where: {
          reelId: input.reelId,
          indexAttemptId: input.indexAttemptId,
        },
        data: { isActive: true },
      });

      return {
        previousIndexAttemptId,
        ...(projectionGeneration ? { projectionGeneration } : {}),
      };
    });
  }

  async rollbackCandidate(input: {
    reelId: string;
    indexAttemptId: string;
    previousIndexAttemptId?: string;
    projectionGeneration?: string;
    publicationToken?: string;
  }): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.reelId}))`;

      if (!(await this.matchesGeneration(transaction, input))) return;

      await this.projections?.assertOwner(transaction, input);
      const journal = await this.journal(transaction, input);
      if (journal?.publicationPhase === 'FINALIZED') return;
      const previousIndexAttemptId = journal
        ? (journal.previousIndexAttemptId ?? undefined)
        : input.previousIndexAttemptId;
      // A stale/failed attempt may finish its content RPC after a newer attempt
      // has already activated. Never let the older rollback deactivate the
      // newer winner. Compensation is valid only while this candidate is still
      // the active semantic candidate under the same per-reel lock.
      const stillActive = await transaction.reelDocument.count({
        where: {
          reelId: input.reelId,
          indexAttemptId: input.indexAttemptId,
          isActive: true,
        },
      });
      if (stillActive !== 1) return;

      await this.setActive(transaction, input.reelId, undefined, false);

      if (journal)
        await transaction.vectorProjection.update({
          where: {
            reelId_generation: {
              reelId: journal.reelId,
              generation: journal.generation,
            },
          },
          data: { publicationPhase: 'COMPENSATED' },
        });
      if (!previousIndexAttemptId) return;
      if (
        journal?.previousGeneration &&
        !(await transaction.vectorProjection.count({
          where: {
            reelId: input.reelId,
            indexAttemptId: previousIndexAttemptId,
            generation: journal.previousGeneration,
            revoked: false,
          },
        }))
      )
        throw new Error('Previous accepted semantic generation is unavailable');

      const restored = await transaction.reelDocument.updateMany({
        where: {
          reelId: input.reelId,
          indexAttemptId: previousIndexAttemptId,
        },
        data: { isActive: true },
      });
      if (restored.count !== 1) {
        throw new Error(
          `Previous semantic candidate ${previousIndexAttemptId} could not be restored`,
        );
      }

      await transaction.reelSection.updateMany({
        where: {
          reelId: input.reelId,
          indexAttemptId: previousIndexAttemptId,
        },
        data: { isActive: true },
      });
      await transaction.reelChunk.updateMany({
        where: {
          reelId: input.reelId,
          indexAttemptId: previousIndexAttemptId,
        },
        data: { isActive: true },
      });
      await transaction.reelVisualScene.updateMany({
        where: {
          reelId: input.reelId,
          indexAttemptId: previousIndexAttemptId,
        },
        data: { isActive: true },
      });
    });
  }

  async finalizeCandidate(input: {
    reelId: string;
    indexAttemptId: string;
    projectionGeneration?: string;
    publicationToken?: string;
  }): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.reelId}))`;

      if (!(await this.matchesGeneration(transaction, input))) return;
      await this.projections?.assertOwner(transaction, input);
      const activeCandidate = await transaction.reelDocument.count({
        where: {
          reelId: input.reelId,
          indexAttemptId: input.indexAttemptId,
          isActive: true,
        },
      });
      if (activeCandidate !== 1) {
        throw new Error(
          `Semantic candidate ${input.indexAttemptId} is not the active candidate`,
        );
      }

      await this.projections?.revoke(transaction, input.reelId, {
        exceptAttempt: input.indexAttemptId,
      });
      await transaction.reelVisualScene.deleteMany({
        where: {
          reelId: input.reelId,
          indexAttemptId: { not: input.indexAttemptId },
        },
      });
      await transaction.reelChunk.deleteMany({
        where: {
          reelId: input.reelId,
          indexAttemptId: { not: input.indexAttemptId },
        },
      });
      await transaction.reelSection.deleteMany({
        where: {
          reelId: input.reelId,
          indexAttemptId: { not: input.indexAttemptId },
        },
      });
      await transaction.reelDocument.deleteMany({
        where: {
          reelId: input.reelId,
          indexAttemptId: { not: input.indexAttemptId },
        },
      });
      await transaction.transcriptionSegment.deleteMany({
        where: {
          reelId: input.reelId,
          indexAttemptId: { not: input.indexAttemptId },
        },
      });

      const journal = await this.journal(transaction, input);
      if (journal)
        await transaction.vectorProjection.update({
          where: {
            reelId_generation: {
              reelId: journal.reelId,
              generation: journal.generation,
            },
          },
          data: { publicationPhase: 'FINALIZED' },
        });
      const completed = await transaction.indexingAttempt.updateMany({
        where: {
          reelId: input.reelId,
          indexAttemptId: input.indexAttemptId,
        },
        data: { status: 'COMPLETED', lastError: null },
      });
      if (completed.count !== 1) {
        throw new Error(`Indexing attempt ${input.indexAttemptId} is missing`);
      }
    });
  }

  async discardCandidate(input: {
    reelId: string;
    indexAttemptId: string;
    projectionGeneration?: string;
    publicationToken?: string;
  }): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.reelId}))`;
      if (!(await this.matchesGeneration(transaction, input))) return;
      // Generic job failure must not erase an unresolved publication journal.
      const journal = await this.journal(transaction, input);
      if (!input.publicationToken && journal?.continuation) return;
      await this.projections?.assertOwner(transaction, input);
      const active = await transaction.reelDocument.count({
        where: {
          reelId: input.reelId,
          indexAttemptId: input.indexAttemptId,
          isActive: true,
        },
      });
      if (active > 0) {
        return;
      }

      await this.projections?.revoke(transaction, input.reelId, {
        indexAttemptId: input.indexAttemptId,
      });
      const identity = {
        reelId: input.reelId,
        indexAttemptId: input.indexAttemptId,
      };
      await transaction.reelVisualScene.deleteMany({ where: identity });
      await transaction.reelChunk.deleteMany({ where: identity });
      await transaction.reelSection.deleteMany({ where: identity });
      await transaction.reelDocument.deleteMany({ where: identity });
      await transaction.transcriptionSegment.deleteMany({ where: identity });
    });
  }

  private async journal(
    transaction: Prisma.TransactionClient,
    input: {
      reelId: string;
      indexAttemptId: string;
      projectionGeneration?: string;
    },
  ) {
    if (!this.projections) return undefined;
    return transaction.vectorProjection.findFirst({
      where: {
        reelId: input.reelId,
        indexAttemptId: input.indexAttemptId,
        revoked: false,
        ...(input.projectionGeneration
          ? { generation: BigInt(input.projectionGeneration) }
          : {}),
      },
    });
  }

  private async matchesGeneration(
    transaction: Prisma.TransactionClient,
    input: {
      reelId: string;
      indexAttemptId: string;
      projectionGeneration?: string;
      publicationToken?: string;
    },
  ): Promise<boolean> {
    if (!input.projectionGeneration) return true;
    return (
      (await transaction.vectorProjection.count({
        where: {
          reelId: input.reelId,
          indexAttemptId: input.indexAttemptId,
          generation: BigInt(input.projectionGeneration),
          revoked: false,
        },
      })) === 1
    );
  }

  private async setActive(
    transaction: Prisma.TransactionClient,
    reelId: string,
    indexAttemptId: string | undefined,
    isActive: boolean,
  ): Promise<void> {
    const where = indexAttemptId ? { reelId, indexAttemptId } : { reelId };
    await transaction.reelVisualScene.updateMany({ where, data: { isActive } });
    await transaction.reelChunk.updateMany({ where, data: { isActive } });
    await transaction.reelSection.updateMany({ where, data: { isActive } });
    await transaction.reelDocument.updateMany({ where, data: { isActive } });
  }
}
