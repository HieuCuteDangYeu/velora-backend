import type { CompleteReelIndexCommand } from '@common/processing/interfaces/complete-reel-index.interface';
import type { ReelIndexJob } from '@common/processing/interfaces/reel-index-job.interface';
import {
  ProjectionPendingError,
  ProjectionSupersededError,
  type ISemanticPublication,
  type IReelVectorStore,
  type VectorTarget,
} from '@indexing/domain/interfaces/reel-vector-store.interface';
import {
  makePoint,
  pointManifest,
  VECTOR_TABLES,
} from '@indexing/domain/services/reel-vector-manifest';
import { PrismaService } from '@indexing/infrastructure/prisma/prisma.service';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Prisma,
  type VectorProjection,
  type VectorProjectionTask,
} from '@prisma/reel-indexing-client';
import { randomUUID } from 'node:crypto';

type Tx = Prisma.TransactionClient;
export type ProjectionContinuation = {
  job: ReelIndexJob;
  completion: CompleteReelIndexCommand;
  projectionGeneration?: string;
  publicationToken?: string;
};

@Injectable()
export class PrismaVectorProjectionRepository implements ISemanticPublication {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject('IReelVectorStore') private readonly store: IReelVectorStore,
  ) {}
  get enabled(): boolean {
    return (
      this.config.get<string>('INDEX_VECTOR_PROJECTION_ENABLED') === 'true'
    );
  }
  get required(): boolean {
    return (
      this.config.get<string>('INDEX_VECTOR_PUBLICATION_REQUIRED') === 'true'
    );
  }

  async points(
    tx: Tx,
    reelId: string,
    indexAttemptId: string,
    generation: bigint,
  ) {
    const points: ReturnType<typeof makePoint>[] = [];
    for (const [kind, table] of Object.entries(VECTOR_TABLES)) {
      const rows = await tx.$queryRaw<
        { record: Record<string, unknown> }[]
      >(Prisma.sql`
        SELECT to_jsonb(t) || jsonb_build_object('embedding', t."embedding"::text) AS record
        FROM ${Prisma.raw(`"${table}"`)} t WHERE "reelId" = ${reelId} AND "indexAttemptId" = ${indexAttemptId}
        ORDER BY "id" LIMIT 20001
      `);
      points.push(
        ...rows.map((row) =>
          makePoint(
            kind as keyof typeof VECTOR_TABLES,
            generation.toString(),
            row.record,
          ),
        ),
      );
      if (points.length > 20000)
        throw new Error('Semantic projection exceeds bounded candidate size');
    }
    const hash = pointManifest(points);
    points.forEach((point) => {
      point.payload.manifestHash = hash;
    });
    return { points, hash };
  }

  async assertReplaceable(
    tx: Tx,
    reelId: string,
    indexAttemptId: string,
  ): Promise<void> {
    if (
      await tx.vectorProjection.count({
        where: {
          reelId,
          revoked: false,
          continuation: { not: Prisma.DbNull },
          OR: [{ indexAttemptId }, { previousIndexAttemptId: indexAttemptId }],
        },
      })
    )
      throw new ProjectionPendingError();
    // Completed attempts are immutable; a retry cannot erase the accepted evidence.
    if (
      await tx.reelDocument.count({
        where: { reelId, indexAttemptId, isActive: true },
      })
    )
      throw new ProjectionSupersededError();
  }

  // Caller holds the same per-Reel lock as semantic persistence.
  async capture(tx: Tx, reelId: string, indexAttemptId: string): Promise<void> {
    await this.revoke(tx, reelId, { indexAttemptId });
    const allocated = await tx.$queryRaw<{ generation: bigint }[]>(Prisma.sql`
      INSERT INTO "VectorReelState" ("reelId", "generation", "deleted") VALUES (${reelId}, 1, false)
      ON CONFLICT ("reelId") DO UPDATE SET "generation" = "VectorReelState"."generation" + 1
        WHERE "VectorReelState"."deleted" = false RETURNING "generation"
    `);
    if (!allocated[0]) throw new Error('Deleted Reel cannot be projected');
    const generation = allocated[0].generation;
    const { points, hash } = await this.points(
      tx,
      reelId,
      indexAttemptId,
      generation,
    );
    if (!points.length)
      throw new Error('Semantic projection candidate is empty');
    await tx.vectorProjection.create({
      data: {
        reelId,
        indexAttemptId,
        generation,
        manifestHash: hash,
        pointCount: points.length,
      },
    });
    await tx.vectorProjectionTask.create({
      data: { reelId, generation, operation: 'UPSERT' },
    });
  }
  async enroll(tx: Tx, reelId: string, indexAttemptId: string): Promise<void> {
    const existing = await tx.vectorProjection.findFirst({
      where: { reelId, indexAttemptId, revoked: false },
    });
    if (!existing) await this.capture(tx, reelId, indexAttemptId);
  }
  async revoke(
    tx: Tx,
    reelId: string,
    selection: {
      indexAttemptId?: string;
      exceptAttempt?: string;
      generation?: string;
    } = {},
  ): Promise<void> {
    const where = {
      reelId,
      revoked: false,
      ...(selection.generation
        ? { generation: BigInt(selection.generation) }
        : {}),
      ...(selection.indexAttemptId
        ? { indexAttemptId: selection.indexAttemptId }
        : selection.exceptAttempt
          ? { indexAttemptId: { not: selection.exceptAttempt } }
          : {}),
    };
    const old = await tx.vectorProjection.findMany({ where });
    for (const candidate of old) {
      await tx.vectorProjectionTask.upsert({
        where: {
          reelId_generation_operation: {
            reelId,
            generation: candidate.generation,
            operation: 'DELETE',
          },
        },
        create: {
          reelId,
          generation: candidate.generation,
          operation: 'DELETE',
        },
        update: { completedAt: null, availableAt: new Date() },
      });
    }
    await tx.vectorProjection.updateMany({
      where,
      data: {
        revoked: true,
        readyAt: null,
        continuation: Prisma.DbNull,
        continuationToken: null,
        continuationUntil: null,
      },
    });
  }
  async tombstone(tx: Tx, reelId: string): Promise<void> {
    await this.revoke(tx, reelId);
    await tx.vectorReelState.upsert({
      where: { reelId },
      create: { reelId, deleted: true, generation: 1 },
      update: { deleted: true, generation: { increment: 1 } },
    });
  }
  async target(
    signal?: AbortSignal,
  ): Promise<VectorTarget & { epoch: string }> {
    const target = await this.store.identity(signal);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('reel-vector-collection'))`;
      const old = await tx.vectorCollectionState.findUnique({
        where: { collection: target.collection },
      });
      if (old?.maintenance) throw new ProjectionPendingError();
      if (old?.fingerprint === target.fingerprint)
        return { ...target, epoch: old.epoch };
      const state = await tx.vectorCollectionState.upsert({
        where: { collection: target.collection },
        create: { ...target, epoch: randomUUID() },
        update: { fingerprint: target.fingerprint, epoch: randomUUID() },
      });
      return { ...target, epoch: state.epoch };
    });
  }
  async invalidate(): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('reel-vector-collection'))`;
      await tx.vectorCollectionState.upsert({
        where: { collection: this.store.collection },
        create: {
          collection: this.store.collection,
          fingerprint: 'MAINTENANCE',
          epoch: randomUUID(),
          maintenance: true,
        },
        update: { maintenance: true },
      });
      await tx.vectorCollectionState.updateMany({
        data: { epoch: randomUUID(), maintenance: true },
      });
      await tx.vectorProjection.updateMany({ data: { readyAt: null } });
    });
  }
  async resumeAfterRestore(): Promise<void> {
    const target = await this.store.identity();
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('reel-vector-collection'))`;
      await tx.vectorProjectionTask.updateMany({
        where: { operation: 'DELETE' },
        data: { completedAt: null, availableAt: new Date() },
      });
      await tx.vectorCollectionState.upsert({
        where: { collection: target.collection },
        create: { ...target, epoch: randomUUID(), maintenance: false },
        update: {
          fingerprint: target.fingerprint,
          epoch: randomUUID(),
          maintenance: false,
        },
      });
    });
  }
  async assertReady(
    tx: Tx,
    reelId: string,
    indexAttemptId: string,
  ): Promise<string | undefined> {
    const candidate = await tx.vectorProjection.findFirst({
      where: { reelId, indexAttemptId, revoked: false },
    });
    if (!this.required) return candidate?.generation.toString();
    if (!candidate?.readyAt || !candidate.readyCollection)
      throw new ProjectionPendingError();
    const target = await tx.vectorCollectionState.findUnique({
      where: { collection: candidate.readyCollection },
    });
    if (
      !target ||
      target.maintenance ||
      candidate.readyEpoch !== target.epoch ||
      candidate.readyFingerprint !== target.fingerprint
    )
      throw new ProjectionPendingError();
    return candidate.generation.toString();
  }
  async defer(input: ProjectionContinuation): Promise<{
    pending: boolean;
    generation?: string;
    token?: string;
    recovering?: boolean;
  }> {
    if (this.required && !this.enabled)
      throw new Error('Publication enforcement requires projection processing');
    let target: Awaited<ReturnType<typeof this.target>> | undefined;
    try {
      if (this.required) target = await this.target(AbortSignal.timeout(250));
    } catch {
      /* Durable continuation also covers an unavailable store. */
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.job.reelId}))`;
      let candidate = await tx.vectorProjection.findFirst({
        where: {
          reelId: input.job.reelId,
          indexAttemptId: input.job.indexAttemptId,
          revoked: false,
        },
      });
      if (
        !candidate &&
        !input.projectionGeneration &&
        (await tx.reelDocument.count({
          where: {
            reelId: input.job.reelId,
            indexAttemptId: input.job.indexAttemptId,
          },
        }))
      ) {
        await this.enroll(tx, input.job.reelId, input.job.indexAttemptId);
        candidate = await tx.vectorProjection.findFirst({
          where: {
            reelId: input.job.reelId,
            indexAttemptId: input.job.indexAttemptId,
            revoked: false,
          },
        });
      }
      if (
        !candidate ||
        (input.projectionGeneration &&
          candidate.generation.toString() !== input.projectionGeneration)
      )
        throw new ProjectionSupersededError();
      const recovering = candidate.publicationPhase !== 'STAGED';
      const pending =
        !recovering &&
        this.required &&
        (!target ||
          !candidate.readyAt ||
          candidate.readyCollection !== target.collection ||
          candidate.readyFingerprint !== target.fingerprint ||
          candidate.readyEpoch !== target.epoch);
      if (input.publicationToken) {
        await this.assertOwner(tx, {
          reelId: candidate.reelId,
          indexAttemptId: candidate.indexAttemptId,
          projectionGeneration: candidate.generation.toString(),
          publicationToken: input.publicationToken,
        });
        return {
          pending,
          generation: candidate.generation.toString(),
          token: input.publicationToken,
          recovering,
        };
      }
      // The foreground takes the same lease as restarted/background publishers.
      const owners = await tx.$queryRaw<{ generation: bigint }[]>(Prisma.sql`
        SELECT "generation" FROM "VectorProjection" WHERE "reelId" = ${candidate.reelId}
          AND NOT "revoked" AND "continuationUntil" >= now()
      `);
      if (owners.length) throw new ProjectionPendingError();
      const token = pending ? null : randomUUID();
      await tx.vectorProjection.update({
        where: {
          reelId_generation: {
            reelId: candidate.reelId,
            generation: candidate.generation,
          },
        },
        data: {
          continuation: JSON.parse(
            JSON.stringify({
              job: input.job,
              completion: input.completion,
              projectionGeneration: candidate.generation.toString(),
            }),
          ) as Prisma.InputJsonValue,
          continuationToken: token,
          continuationUntil: token ? new Date(Date.now() + 120000) : null,
        },
      });
      return {
        generation: candidate.generation.toString(),
        pending,
        ...(token ? { token } : {}),
        recovering,
      };
    });
  }

  // All callers hold the per-Reel transaction lock. Use the database clock for expiry.
  async assertOwner(
    tx: Tx,
    input: {
      reelId: string;
      indexAttemptId: string;
      projectionGeneration?: string;
      publicationToken?: string;
    },
  ): Promise<void> {
    if (!input.publicationToken) {
      if (
        await tx.vectorProjection.count({
          where: {
            reelId: input.reelId,
            indexAttemptId: input.indexAttemptId,
            revoked: false,
            ...(input.projectionGeneration
              ? { generation: BigInt(input.projectionGeneration) }
              : {}),
            continuation: { not: Prisma.DbNull },
          },
        })
      )
        throw new ProjectionPendingError();
      return;
    }
    const owners = await tx.$queryRaw<{ generation: bigint }[]>(Prisma.sql`
      SELECT "generation" FROM "VectorProjection" WHERE "reelId" = ${input.reelId}
        AND "indexAttemptId" = ${input.indexAttemptId} AND "generation" = ${BigInt(input.projectionGeneration!)}
        AND NOT "revoked" AND "continuationToken" = ${input.publicationToken} AND "continuationUntil" > now()
    `);
    if (!owners.length) throw new ProjectionPendingError();
  }

  async complete(
    reelId: string,
    indexAttemptId: string,
    generation?: string,
    token?: string,
  ): Promise<void> {
    if (!generation || !token) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${reelId}))`;
      await this.assertOwner(tx, {
        reelId,
        indexAttemptId,
        projectionGeneration: generation,
        publicationToken: token,
      });
      await tx.vectorProjection.updateMany({
        where: {
          reelId,
          indexAttemptId,
          generation: BigInt(generation),
          publicationPhase: 'FINALIZED',
          continuationToken: token,
        },
        data: {
          continuation: Prisma.DbNull,
          continuationToken: null,
          continuationUntil: null,
        },
      });
    });
  }
  async release(
    reelId: string,
    indexAttemptId: string,
    generation: string,
    token: string,
  ): Promise<void> {
    await this.prisma.vectorProjection.updateMany({
      where: {
        reelId,
        indexAttemptId,
        generation: BigInt(generation),
        continuationToken: token,
      },
      data: {
        continuationToken: null,
        continuationUntil: null,
        continuationAfter: new Date(Date.now() + 5000),
      },
    });
  }

  async claim(): Promise<VectorProjectionTask | undefined> {
    return this.prisma.$transaction(async (tx) => {
      const reels = await tx.$queryRaw<{ reelId: string }[]>(Prisma.sql`
        SELECT r."reelId" FROM "VectorReelState" r WHERE EXISTS (
          SELECT 1 FROM "VectorProjectionTask" t WHERE t."reelId" = r."reelId" AND t."completedAt" IS NULL
            AND t."availableAt" <= now() AND (t."leaseUntil" IS NULL OR t."leaseUntil" < now())
        ) AND NOT EXISTS (SELECT 1 FROM "VectorProjectionTask" t WHERE t."reelId" = r."reelId" AND t."leaseUntil" >= now())
        ORDER BY r."reelId" FOR UPDATE OF r SKIP LOCKED LIMIT 1
      `);
      if (!reels[0]) return undefined;
      const token = randomUUID();
      const tasks = await tx.$queryRaw<VectorProjectionTask[]>(Prisma.sql`
      WITH next AS (
        SELECT t."id" FROM "VectorProjectionTask" t
        WHERE t."reelId" = ${reels[0].reelId} AND t."completedAt" IS NULL AND t."availableAt" <= now() AND (t."leaseUntil" IS NULL OR t."leaseUntil" < now())
          AND NOT EXISTS (SELECT 1 FROM "VectorProjectionTask" other WHERE other."reelId" = t."reelId" AND other."leaseUntil" >= now())
        ORDER BY t."id" FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE "VectorProjectionTask" t SET "leaseToken" = ${token}, "leaseUntil" = now() + interval '120 seconds', "attempts" = "attempts" + 1
        FROM next WHERE t."id" = next."id" RETURNING t.*
    `);
      return tasks[0];
    });
  }
  private async renew(task: VectorProjectionTask): Promise<void> {
    const count = await this.prisma.vectorProjectionTask.updateMany({
      where: {
        id: task.id,
        leaseToken: task.leaseToken,
        leaseUntil: { gt: new Date() },
      },
      data: { leaseUntil: new Date(Date.now() + 120000) },
    });
    if (count.count !== 1) throw new Error('Projection lease expired');
  }
  async apply(task: VectorProjectionTask): Promise<void> {
    const projection = await this.prisma.vectorProjection.findUniqueOrThrow({
      where: {
        reelId_generation: { reelId: task.reelId, generation: task.generation },
      },
    });
    if (task.operation === 'DELETE') {
      if (!projection.revoked)
        throw new Error('Refusing to delete a current projection');
      await this.store.remove({
        reelId: projection.reelId,
        indexAttemptId: projection.indexAttemptId,
        projectionGeneration: projection.generation.toString(),
        manifestHash: projection.manifestHash,
      });
    } else if (!projection.revoked) {
      const target = await this.target();
      const snapshot = await this.prisma.$transaction(
        (tx) =>
          this.points(
            tx,
            projection.reelId,
            projection.indexAttemptId,
            projection.generation,
          ),
        { isolationLevel: 'RepeatableRead' },
      );
      if (
        snapshot.hash !== projection.manifestHash ||
        snapshot.points.length !== projection.pointCount
      )
        throw new Error('SQL projection manifest changed');
      for (let i = 0; i < snapshot.points.length; i += 128) {
        await this.renew(task);
        await this.store.upsert(snapshot.points.slice(i, i + 128));
      }
      await this.renew(task);
      await this.store.verify(snapshot.points);
      const after = await this.target();
      if (
        after.fingerprint !== target.fingerprint ||
        after.epoch !== target.epoch
      )
        throw new Error('Projection target changed');
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${projection.reelId}))`;
        const lease = await tx.vectorProjectionTask.findFirst({
          where: {
            id: task.id,
            leaseToken: task.leaseToken,
            leaseUntil: { gt: new Date() },
          },
        });
        const current = await tx.vectorProjection.findUnique({
          where: {
            reelId_generation: {
              reelId: projection.reelId,
              generation: projection.generation,
            },
          },
        });
        const state = await tx.vectorCollectionState.findUnique({
          where: { collection: target.collection },
        });
        const rows = await this.points(
          tx,
          projection.reelId,
          projection.indexAttemptId,
          projection.generation,
        );
        if (
          !lease ||
          !current ||
          current.revoked ||
          current.manifestHash !== rows.hash ||
          rows.points.length !== current.pointCount ||
          state?.maintenance ||
          state?.epoch !== target.epoch
        )
          throw new Error('Projection certification fence changed');
        await tx.vectorProjection.update({
          where: {
            reelId_generation: {
              reelId: projection.reelId,
              generation: projection.generation,
            },
          },
          data: {
            readyCollection: target.collection,
            readyFingerprint: target.fingerprint,
            readyEpoch: target.epoch,
            readyAt: new Date(),
          },
        });
      });
    }
    const applied = await this.prisma.vectorProjectionTask.updateMany({
      where: {
        id: task.id,
        leaseToken: task.leaseToken,
        leaseUntil: { gt: new Date() },
      },
      data: {
        completedAt: new Date(),
        leaseToken: null,
        leaseUntil: null,
        lastError: null,
      },
    });
    if (applied.count !== 1)
      throw new Error('Projection completion lease expired');
  }
  async retry(task: VectorProjectionTask): Promise<void> {
    await this.prisma.vectorProjectionTask.updateMany({
      where: { id: task.id, leaseToken: task.leaseToken },
      data: {
        leaseToken: null,
        leaseUntil: null,
        availableAt: new Date(
          Date.now() + Math.min(300000, 1000 * 2 ** Math.min(task.attempts, 8)),
        ),
        lastError: 'PROJECTION_UNAVAILABLE_OR_FENCE_CHANGED',
      },
    });
  }
  async reconcile(): Promise<void> {
    // Re-run obsolete-generation cleanup after bounded in-flight requests have settled.
    await this.prisma
      .$executeRaw`UPDATE "VectorProjectionTask" t SET "completedAt" = NULL, "availableAt" = now()
      FROM "VectorProjection" p WHERE p."reelId" = t."reelId" AND p."generation" = t."generation"
      AND t."completedAt" IS NOT NULL AND (
        (t."operation" = 'DELETE' AND p."revoked" AND t."completedAt" < now() - interval '5 minutes') OR
        (t."operation" = 'UPSERT' AND NOT p."revoked" AND (p."readyAt" IS NULL OR NOT EXISTS (
          SELECT 1 FROM "VectorCollectionState" s WHERE s."collection" = p."readyCollection" AND s."epoch" = p."readyEpoch" AND s."fingerprint" = p."readyFingerprint"
        )))
      )`;
  }
  async claimContinuation(): Promise<VectorProjection | undefined> {
    const next = await this.prisma.vectorProjection.findFirst({
      where: {
        revoked: false,
        continuation: { not: Prisma.DbNull },
        continuationAfter: { lte: new Date() },
        OR: [
          { continuationUntil: null },
          { continuationUntil: { lt: new Date() } },
        ],
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!next) return undefined;
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${next.reelId}))`;
      const rows = await tx.$queryRaw<VectorProjection[]>(Prisma.sql`
        UPDATE "VectorProjection" p SET "continuationToken" = ${randomUUID()}, "continuationUntil" = now() + interval '120 seconds'
        WHERE p."reelId" = ${next.reelId} AND p."generation" = ${next.generation} AND NOT p."revoked"
          AND p."continuation" IS NOT NULL AND p."continuationAfter" <= now()
          AND NOT EXISTS (SELECT 1 FROM "VectorProjection" other WHERE other."reelId" = p."reelId"
            AND NOT other."revoked" AND other."continuationUntil" >= now()) RETURNING p.*
      `);
      return rows[0];
    });
  }
}
