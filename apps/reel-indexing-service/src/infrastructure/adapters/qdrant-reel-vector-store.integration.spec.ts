import * as migrationModule from '../../../../../scripts/ops/reel-qdrant.cjs';
import * as backupModule from '../../../../../scripts/ops/qdrant-backup.cjs';
import { ConfigService } from '@nestjs/config';
import { PrismaClient, Prisma } from '@prisma/reel-indexing-client';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import type { SemanticIndexCandidate } from '@indexing/domain/interfaces/semantic-index.repository.interface';
import {
  ProjectionPendingError,
  type IReelVectorStore,
} from '@indexing/domain/interfaces/reel-vector-store.interface';
import { QdrantReelVectorStoreAdapter } from './qdrant-reel-vector-store.adapter';
import { PrismaVectorProjectionRepository } from '../repositories/prisma-vector-projection.repository';
import { PrismaSemanticIndexRepository } from '../repositories/prisma-semantic-index.repository';
import { PrismaSemanticCandidateLifecycle } from '../repositories/prisma-semantic-candidate-lifecycle';
import { CommitSemanticCandidateUseCase } from '@indexing/application/use-cases/commit-semantic-candidate.use-case';
import { VectorProjectionWorker } from '../services/vector-projection-worker.service';

const enabled =
  !!process.env.QDRANT_TEST_URL &&
  !!process.env.REEL_INDEXING_TEST_DATABASE_URL;
(enabled ? describe : describe.skip)(
  'real Qdrant v1.20 and PostgreSQL projection',
  () => {
    let directory: string;
    const collection = `test_${randomUUID().replaceAll('-', '')}`;
    let config: ConfigService;
    let prisma: PrismaClient;
    let store: QdrantReelVectorStoreAdapter;
    let projection: PrismaVectorProjectionRepository;
    let repository: PrismaSemanticIndexRepository;
    let lifecycle: PrismaSemanticCandidateLifecycle;
    const reelId = randomUUID();
    const vector = (sign = 1) => [sign, ...Array<number>(1023).fill(0)];
    function candidate(
      attempt = randomUUID(),
      sign = 1,
    ): SemanticIndexCandidate {
      return {
        job: {
          jobId: randomUUID(),
          reelId,
          userId: 'owner',
          mediaAttemptId: 'media',
          indexAttemptId: attempt,
          indexVersion: 'reel-index-v2',
          mediaKey: 'source.mp4',
          sourceDurationMs: 30000,
          sourceOrientation: 'PORTRAIT',
          sourceLengthClass: 'SHORT',
          tags: ['science'],
          createdAt: new Date().toISOString(),
          schemaVersion: 1,
        },
        metadata: { title: 'Science', tags: ['science'] },
        documents: (['REEL', 'SECTION', 'CHUNK', 'VISUAL_SCENE'] as const).map(
          (kind, ordinal) => ({
            id: `${kind}:${reelId}`,
            reelId,
            kind,
            ordinal,
            parentId: kind === 'REEL' ? undefined : `REEL:${reelId}`,
            startTime: 0,
            endTime: 30,
            retrievalText: 'science universe astronomy',
            sourceSectionIds: [],
            sourceSegmentIds: [],
            sourceAudioArtifactIds: [],
            retrievalHash: 'retrieval',
            evidenceHash: 'evidence',
            evidenceText: 'science universe astronomy',
            evidenceQuality: 'VERIFIED',
            sectioningVersion: 'v1',
            chunkingVersion: 'v1',
            summaryVersion: 'v1',
            indexVersion: 'reel-index-v2',
            embeddingProvider: 'self-hosted-tei',
            embeddingModel: 'BAAI/bge-m3',
            embeddingDimensions: 1024,
            embeddingVersion: 'bge-m3-tei-v1',
            embeddingInputHash: 'input',
            embedding: vector(sign),
            tokenCount: 3,
          }),
        ),
      };
    }
    async function persist(input: SemanticIndexCandidate) {
      await prisma.indexingAttempt.upsert({
        where: { indexAttemptId: input.job.indexAttemptId },
        create: {
          indexAttemptId: input.job.indexAttemptId,
          reelId,
          jobId: input.job.jobId,
          mediaAttemptId: 'media',
          indexVersion: 'reel-index-v2',
        },
        update: {},
      });
      await repository.persistCandidate(input);
      return prisma.vectorProjection.findFirstOrThrow({
        where: {
          reelId,
          indexAttemptId: input.job.indexAttemptId,
          revoked: false,
        },
      });
    }
    async function drain() {
      for (let i = 0; i < 100; i++) {
        const task = await projection.claim();
        if (!task) {
          if (
            !(await prisma.vectorProjectionTask.count({
              where: { reelId, completedAt: null },
            }))
          )
            return;
          // TIMESTAMP(3) can round availableAt just beyond the next claim's clock.
          await new Promise((resolve) => setTimeout(resolve, 5));
          continue;
        }
        await projection.apply(task);
      }
      throw new Error('Projection queue did not drain');
    }
    const query = () => ({
      queryEmbedding: vector(),
      queryEmbeddingModel: 'BAAI/bge-m3',
      queryEmbeddingVersion: 'bge-m3-tei-v1',
      filters: { reelIds: [reelId] },
      requiredIndexVersion: 'reel-index-v2',
      limit: 10,
    });
    beforeAll(async () => {
      for (const target of [
        process.env.QDRANT_TEST_URL!,
        process.env.REEL_INDEXING_TEST_DATABASE_URL!,
      ])
        if (
          !['localhost', '127.0.0.1', '[::1]'].includes(
            new URL(target).hostname,
          )
        )
          throw new Error(
            'Integration requires loopback-only disposable targets',
          );
      directory = mkdtempSync(join(tmpdir(), 'reel-qdrant-test-'));
      const values = {
        QDRANT_URL: process.env.QDRANT_TEST_URL!,
        QDRANT_COLLECTION: collection,
        QDRANT_ALLOW_LOCAL_HTTP: 'true',
        QDRANT_API_KEY_FILE: join(directory, 'key'),
        INDEX_VECTOR_PROJECTION_ENABLED: 'true',
        INDEX_VECTOR_PUBLICATION_REQUIRED: 'true',
        INDEX_VECTOR_SEARCH_BACKEND: 'qdrant',
        INDEX_EMBEDDING_PROVIDER: 'self-hosted-tei',
        AI_EMBEDDING_MODEL: 'BAAI/bge-m3',
        AI_EMBEDDING_DIMENSIONS: '1024',
        AI_EMBEDDING_VERSION: 'bge-m3-tei-v1',
      };
      config = new ConfigService(values);
      prisma = new PrismaClient({
        datasources: {
          db: { url: process.env.REEL_INDEXING_TEST_DATABASE_URL },
        },
      });
      store = new QdrantReelVectorStoreAdapter(config);
      projection = new PrismaVectorProjectionRepository(
        prisma as never,
        config,
        store,
      );
      repository = new PrismaSemanticIndexRepository(
        prisma as never,
        config,
        projection,
        store,
      );
      lifecycle = new PrismaSemanticCandidateLifecycle(
        prisma as never,
        projection,
      );
      writeFileSync(
        values.QDRANT_API_KEY_FILE,
        process.env.QDRANT_TEST_KEY || 'local-disposable-test-key',
        { mode: 0o600 },
      );
      await store.initialize();
    });
    afterEach(() => jest.restoreAllMocks());
    afterAll(async () => {
      if (!prisma) return;
      await repository.deleteReel(reelId);
      await store.request(`/collections/${collection}`, 'DELETE');
      await prisma.vectorProjectionTask.deleteMany({ where: { reelId } });
      await prisma.vectorProjection.deleteMany({ where: { reelId } });
      await prisma.vectorReelState.deleteMany({ where: { reelId } });
      await prisma.vectorCollectionState.deleteMany({ where: { collection } });
      await prisma.$disconnect();
      rmSync(directory, { recursive: true, force: true });
    });
    it('enrolls a pre-migration persisted candidate with projection disabled and no Qdrant call', async () => {
      const input = candidate();
      const state = await persist(input);
      await prisma.vectorProjectionTask.deleteMany({
        where: { reelId, generation: state.generation },
      });
      await prisma.vectorProjection.deleteMany({
        where: { reelId, generation: state.generation },
      });
      config.set('INDEX_VECTOR_PUBLICATION_REQUIRED', 'false');
      config.set('INDEX_VECTOR_PROJECTION_ENABLED', 'false');
      const identity = jest.spyOn(store, 'identity');
      try {
        const deferred = await projection.defer({
          job: input.job,
          completion: {
            reelId,
            indexAttemptId: input.job.indexAttemptId,
          } as never,
        });
        expect(deferred.pending).toBe(false);
        expect(identity).not.toHaveBeenCalled();
        expect(BigInt(deferred.generation!)).toBeGreaterThan(state.generation);
        await lifecycle.discardCandidate({
          reelId,
          indexAttemptId: input.job.indexAttemptId,
          projectionGeneration: deferred.generation,
          publicationToken: deferred.token,
        });
      } finally {
        config.set('INDEX_VECTOR_PUBLICATION_REQUIRED', 'true');
        config.set('INDEX_VECTOR_PROJECTION_ENABLED', 'true');
        identity.mockRestore();
      }
      await drain();
    });
    it('enforces readiness, idempotent projection, all four kinds, negative distance and unchanged RRF', async () => {
      const input = candidate(undefined, -1);
      const state = await persist(input);
      await expect(
        lifecycle.activateCandidate({
          reelId,
          indexAttemptId: input.job.indexAttemptId,
        }),
      ).rejects.toBeInstanceOf(ProjectionPendingError);
      const task = await projection.claim();
      expect(task).toBeDefined();
      await projection.apply(task!);
      const points = await prisma.$transaction((tx) =>
        projection.points(
          tx,
          reelId,
          input.job.indexAttemptId,
          state.generation,
        ),
      );
      await store.upsert(points.points);
      await store.verify(points.points);
      await lifecycle.activateCandidate({
        reelId,
        indexAttemptId: input.job.indexAttemptId,
        projectionGeneration: state.generation.toString(),
      });
      await lifecycle.finalizeCandidate({
        reelId,
        indexAttemptId: input.job.indexAttemptId,
        projectionGeneration: state.generation.toString(),
      });
      const search = jest.spyOn(store, 'search');
      for (const method of [
        'searchReels',
        'searchSections',
        'searchChunks',
        'searchVisualScenes',
      ] as const) {
        const result = await repository[method](query());
        expect(result).toHaveLength(1);
        expect(result[0].vectorDistance).toBeCloseTo(2, 5);
        expect(result[0].rrfScore).toBeCloseTo(1 / 61, 10);
      }
      expect(search).toHaveBeenCalledTimes(4);
      search.mockRestore();
      config.set('INDEX_VECTOR_SEARCH_BACKEND', 'postgres');
      const pg = await repository.searchReels({
        ...query(),
        queryText: 'science',
        queryTags: ['science'],
      });
      config.set('INDEX_VECTOR_SEARCH_BACKEND', 'qdrant');
      expect(
        await repository.searchReels({
          ...query(),
          queryText: 'science',
          queryTags: ['science'],
        }),
      ).toEqual(pg);
      expect(
        await repository.searchReels({ ...query(), filters: { reelIds: [] } }),
      ).toEqual([]);
      expect(
        await repository.searchReels({
          ...query(),
          filters: { reelIds: [reelId], tags: ['foreign'] },
        }),
      ).toEqual([]);
      expect(
        await repository.searchReels({
          ...query(),
          excludedIds: [input.documents[0].id],
        }),
      ).toEqual([]);
    });
    it('falls back fully on transport failure and preserves lexical-only behavior without a vector call', async () => {
      const unavailable = jest
        .spyOn(store, 'identity')
        .mockRejectedValue(new Error('timeout'));
      const result = await repository.searchReels(query());
      expect(result[0].vectorDistance).toBeCloseTo(2);
      unavailable.mockClear();
      const lexical = await repository.searchReels({
        queryText: 'science',
        filters: { reelIds: [reelId] },
      });
      expect(lexical).toHaveLength(1);
      expect(lexical[0].vectorDistance).toBeUndefined();
      expect(unavailable).not.toHaveBeenCalled();
      unavailable.mockRestore();
    });
    it('compensates rejected Content completion without deleting the previous accepted points', async () => {
      const previous = await prisma.reelDocument.findFirstOrThrow({
        where: { reelId, isActive: true },
      });
      const input = candidate();
      await persist(input);
      await drain();
      const content = {
        isIndexingAttemptCurrent: jest.fn().mockResolvedValue(true),
        completeIndexing: jest.fn().mockResolvedValue(false),
      };
      const commit = new CommitSemanticCandidateUseCase(
        content as never,
        lifecycle,
        projection,
      );
      expect(
        await commit.execute({
          job: input.job,
          completion: {
            reelId,
            indexAttemptId: input.job.indexAttemptId,
          } as never,
        }),
      ).toBe('STALE');
      expect(
        (
          await prisma.reelDocument.findFirstOrThrow({
            where: { reelId, isActive: true },
          })
        ).indexAttemptId,
      ).toBe(previous.indexAttemptId);
      await drain();
      expect(await repository.searchReels(query())).toHaveLength(1);
    });
    it('fences expired leases and same-attempt replacement, including a late write', async () => {
      const input = candidate();
      const first = await persist(input);
      const staleTask = await projection.claim();
      const stalePoints = await prisma.$transaction((tx) =>
        projection.points(
          tx,
          reelId,
          input.job.indexAttemptId,
          first.generation,
        ),
      );
      await prisma.vectorProjectionTask.update({
        where: { id: staleTask!.id },
        data: { leaseUntil: new Date(0) },
      });
      const newer = await persist(input);
      expect(newer.generation > first.generation).toBe(true);
      await store.upsert(stalePoints.points);
      await expect(projection.apply(staleTask!)).rejects.toThrow();
      await expect(
        lifecycle.activateCandidate({
          reelId,
          indexAttemptId: input.job.indexAttemptId,
          projectionGeneration: first.generation.toString(),
        }),
      ).rejects.toThrow('superseded');
      await drain();
      await lifecycle.activateCandidate({
        reelId,
        indexAttemptId: input.job.indexAttemptId,
        projectionGeneration: newer.generation.toString(),
      });
      await lifecycle.finalizeCandidate({
        reelId,
        indexAttemptId: input.job.indexAttemptId,
        projectionGeneration: newer.generation.toString(),
      });
      await store.upsert(stalePoints.points);
      expect(await repository.searchReels(query())).toHaveLength(1);
      await prisma.vectorProjectionTask.updateMany({
        where: { reelId, generation: first.generation, operation: 'DELETE' },
        data: { completedAt: new Date(0) },
      });
      await projection.reconcile();
      await drain();
      expect(
        (
          await prisma.vectorProjection.findUniqueOrThrow({
            where: {
              reelId_generation: { reelId, generation: first.generation },
            },
          })
        ).readyAt,
      ).toBeNull();
    });
    it('serializes cross-instance claims per Reel and rejects acknowledgement loss only after lease expiry', async () => {
      await persist(candidate());
      await persist(candidate());
      const claims = await Promise.all([
        projection.claim(),
        projection.claim(),
        projection.claim(),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      await projection.apply(claims.find(Boolean)!);
      await drain();
    });
    it('replays a partially acknowledged multi-batch projection without certifying partial coverage', async () => {
      const input = candidate();
      const chunk = input.documents.find(
        (document) => document.kind === 'CHUNK',
      )!;
      input.documents = [
        ...input.documents.filter((document) => document.kind !== 'CHUNK'),
        ...Array.from({ length: 130 }, (_, ordinal) => ({
          ...chunk,
          id: `${chunk.id}:${ordinal}`,
          ordinal,
        })),
      ];
      const state = await persist(input);
      const task = await projection.claim();
      const real = store.upsert.bind(store) as IReelVectorStore['upsert'];
      let batches = 0;
      const lostAck = jest
        .spyOn(store, 'upsert')
        .mockImplementation(async (points) => {
          await real(points);
          if (++batches === 2) throw new Error('Acknowledgement lost');
        });
      await expect(projection.apply(task!)).rejects.toThrow(
        'Acknowledgement lost',
      );
      expect(
        (
          await prisma.vectorProjection.findUniqueOrThrow({
            where: {
              reelId_generation: { reelId, generation: state.generation },
            },
          })
        ).readyAt,
      ).toBeNull();
      lostAck.mockRestore();
      await projection.retry(task!);
      await prisma.vectorProjectionTask.update({
        where: { id: task!.id },
        data: { availableAt: new Date(0) },
      });
      await drain();
      expect(
        (
          await prisma.vectorProjection.findUniqueOrThrow({
            where: {
              reelId_generation: { reelId, generation: state.generation },
            },
          })
        ).readyAt,
      ).not.toBeNull();
    });
    it('resumes durable pending publication without providers or broker retries', async () => {
      const input = candidate();
      await persist(input);
      const content = {
        isIndexingAttemptCurrent: jest.fn().mockResolvedValue(true),
        completeIndexing: jest.fn().mockResolvedValue(true),
      };
      const commit = new CommitSemanticCandidateUseCase(
        content as never,
        lifecycle,
        projection,
      );
      await expect(
        commit.execute({
          job: input.job,
          completion: {
            reelId,
            indexAttemptId: input.job.indexAttemptId,
          } as never,
        }),
      ).rejects.toBeInstanceOf(ProjectionPendingError);
      expect(
        await prisma.vectorProjection.count({
          where: { reelId, continuation: { not: Prisma.DbNull } },
        }),
      ).toBe(1);
      const worker = new VectorProjectionWorker(projection, commit);
      for (
        let i = 0;
        i < 15 && !content.completeIndexing.mock.calls.length;
        i++
      )
        await worker.tick();
      expect(content.completeIndexing).toHaveBeenCalledTimes(1);
      expect(
        (
          await prisma.indexingAttempt.findUniqueOrThrow({
            where: { indexAttemptId: input.job.indexAttemptId },
          })
        ).status,
      ).toBe('COMPLETED');
    });
    describe('durable activation recovery and publication ownership', () => {
      const freshClients: PrismaClient[] = [];
      function fresh(content: {
        isIndexingAttemptCurrent: jest.Mock;
        completeIndexing: jest.Mock;
      }) {
        const client = new PrismaClient({
          datasources: {
            db: { url: process.env.REEL_INDEXING_TEST_DATABASE_URL! },
          },
        });
        freshClients.push(client);
        const projections = new PrismaVectorProjectionRepository(
          client as never,
          config,
          new QdrantReelVectorStoreAdapter(config),
        );
        const candidates = new PrismaSemanticCandidateLifecycle(
          client as never,
          projections,
        );
        const commit = new CommitSemanticCandidateUseCase(
          content as never,
          candidates,
          projections,
        );
        return {
          client,
          projections,
          candidates,
          commit,
          worker: new VectorProjectionWorker(projections, commit),
        };
      }
      afterEach(async () => {
        await Promise.all(
          freshClients.splice(0).map((client) => client.$disconnect()),
        );
      });
      const command = (input: SemanticIndexCandidate) => ({
        job: input.job,
        completion: {
          reelId,
          indexAttemptId: input.job.indexAttemptId,
        } as never,
      });
      const accepts = () => ({
        isIndexingAttemptCurrent: jest.fn().mockResolvedValue(true),
        completeIndexing: jest.fn().mockResolvedValue(true),
      });
      async function activeIs(client: PrismaClient, attempt: string) {
        for (const table of [
          'ReelDocument',
          'ReelSection',
          'ReelChunk',
          'ReelVisualScene',
        ]) {
          const rows = await client.$queryRaw<{ indexAttemptId: string }[]>(
            Prisma.sql`SELECT "indexAttemptId" FROM ${Prisma.raw(`"${table}"`)} WHERE "reelId" = ${reelId} AND "isActive"`,
          );
          expect(rows).toEqual([{ indexAttemptId: attempt }]);
        }
        expect(await repository.searchReels(query())).toHaveLength(1);
      }
      async function acceptedA() {
        const a = candidate();
        const state = await persist(a);
        await drain();
        await fresh(accepts()).commit.execute(command(a));
        return { input: a, state };
      }
      async function crashAfterActivation() {
        const a = await acceptedA();
        const b = candidate();
        const state = await persist(b);
        await drain();
        const owner = await projection.defer(command(b));
        const identity = {
          reelId,
          indexAttemptId: b.job.indexAttemptId,
          projectionGeneration: state.generation.toString(),
          publicationToken: owner.token,
        };
        await lifecycle.activateCandidate(identity);
        const journal = await prisma.vectorProjection.findUniqueOrThrow({
          where: {
            reelId_generation: { reelId, generation: state.generation },
          },
        });
        expect(journal).toMatchObject({
          previousIndexAttemptId: a.input.job.indexAttemptId,
          previousGeneration: a.state.generation,
          publicationPhase: 'ACTIVATED',
        });
        // Lose the activation result and expire the crashed publisher's SQL lease.
        await eligible(state.generation);
        return { a, b, state, identity };
      }
      async function eligible(generation: bigint) {
        await prisma.vectorProjection.update({
          where: { reelId_generation: { reelId, generation } },
          data: {
            continuationUntil: new Date(0),
            continuationAfter: new Date(0),
          },
        });
      }
      it.each([false, true])(
        'restores A after a post-activation crash, current=%s and rejection',
        async (current) => {
          const { a, b, state } = await crashAfterActivation();
          const content = {
            isIndexingAttemptCurrent: jest.fn().mockResolvedValue(current),
            completeIndexing: jest.fn().mockResolvedValue(false),
          };
          const restarted = fresh(content);
          await restarted.worker.tick();
          await activeIs(restarted.client, a.input.job.indexAttemptId);
          const journal =
            await restarted.client.vectorProjection.findUniqueOrThrow({
              where: {
                reelId_generation: { reelId, generation: state.generation },
              },
            });
          expect(journal).toMatchObject({
            revoked: true,
            publicationPhase: 'COMPENSATED',
            continuation: null,
            continuationToken: null,
          });
          expect(content.completeIndexing).toHaveBeenCalledTimes(1);
          expect(
            await restarted.client.reelDocument.count({
              where: { reelId, indexAttemptId: b.job.indexAttemptId },
            }),
          ).toBe(0);
          const points = await prisma.$transaction((tx) =>
            projection.points(
              tx,
              reelId,
              a.input.job.indexAttemptId,
              a.state.generation,
            ),
          );
          await store.verify(points.points);
        },
      );
      it('restores A on an RPC error and recovers a durable compensated generation after acknowledgement loss', async () => {
        const { a, b, state } = await crashAfterActivation();
        const restarted = fresh({
          isIndexingAttemptCurrent: jest.fn().mockResolvedValue(true),
          completeIndexing: jest
            .fn()
            .mockRejectedValue(new Error('RPC unavailable')),
        });
        await restarted.worker.tick();
        await activeIs(restarted.client, a.input.job.indexAttemptId);
        const journal =
          await restarted.client.vectorProjection.findUniqueOrThrow({
            where: {
              reelId_generation: { reelId, generation: state.generation },
            },
          });
        expect(journal).toMatchObject({
          revoked: false,
          publicationPhase: 'COMPENSATED',
          previousIndexAttemptId: a.input.job.indexAttemptId,
          previousGeneration: a.state.generation,
          continuationToken: null,
        });
        expect(journal.continuation).not.toBeNull();
        // Generic broker error cleanup and same-attempt retries cannot erase recovery.
        await restarted.candidates.discardCandidate({
          reelId,
          indexAttemptId: b.job.indexAttemptId,
        });
        await expect(persist(b)).rejects.toBeInstanceOf(ProjectionPendingError);
        expect(
          await restarted.client.reelDocument.count({
            where: { reelId, indexAttemptId: b.job.indexAttemptId },
          }),
        ).toBe(1);
        await eligible(state.generation);
        const idempotent = fresh({
          isIndexingAttemptCurrent: jest.fn().mockResolvedValue(false),
          completeIndexing: jest.fn().mockResolvedValue(true),
        });
        await idempotent.worker.tick();
        await activeIs(idempotent.client, b.job.indexAttemptId);
        expect(
          await idempotent.client.vectorProjection.findUniqueOrThrow({
            where: {
              reelId_generation: { reelId, generation: state.generation },
            },
          }),
        ).toMatchObject({ publicationPhase: 'FINALIZED', continuation: null });
      });
      it('finalizes B after a crash following Content acceptance, whose current check is PROCESSING-only', async () => {
        const { b, state } = await crashAfterActivation();
        let accepted = false;
        const content = {
          isIndexingAttemptCurrent: jest.fn(() => Promise.resolve(!accepted)),
          completeIndexing: jest.fn(() => {
            accepted = true;
            return Promise.resolve(true);
          }),
        };
        const first = fresh(content);
        jest
          .spyOn(first.candidates, 'finalizeCandidate')
          .mockRejectedValue(new Error('crash before finalization'));
        await expect(
          first.commit.execute({
            ...command(b),
            projectionGeneration: state.generation.toString(),
          }),
        ).resolves.toBe('COMPLETED');
        expect(accepted).toBe(true);
        expect(
          await prisma.vectorProjection.findUniqueOrThrow({
            where: {
              reelId_generation: { reelId, generation: state.generation },
            },
          }),
        ).toMatchObject({ publicationPhase: 'ACTIVATED' });
        await eligible(state.generation);
        const restarted = fresh(content);
        await restarted.worker.tick();
        await activeIs(restarted.client, b.job.indexAttemptId);
        expect(content.completeIndexing).toHaveBeenCalledTimes(2);
        expect(
          await restarted.client.vectorProjection.findUniqueOrThrow({
            where: {
              reelId_generation: { reelId, generation: state.generation },
            },
          }),
        ).toMatchObject({ publicationPhase: 'FINALIZED', continuation: null });
      });
      it('excludes overlapping foreground/background publishers and fences an expired same-generation callback', async () => {
        await acceptedA();
        const b = candidate();
        const state = await persist(b);
        await drain();
        let finish!: (value: boolean) => void, started!: () => void;
        const inRpc = new Promise<void>((resolve) => {
          started = resolve;
        });
        const response = new Promise<boolean>((resolve) => {
          finish = resolve;
        });
        const foreground = fresh({
          isIndexingAttemptCurrent: jest.fn().mockResolvedValue(true),
          completeIndexing: jest.fn(() => {
            started();
            return response;
          }),
        });
        const running = foreground.commit.execute(command(b));
        await inRpc;
        const backgroundContent = accepts();
        const background = fresh(backgroundContent);
        await background.worker.tick();
        expect(backgroundContent.completeIndexing).not.toHaveBeenCalled();
        await expect(
          background.commit.execute(command(b)),
        ).rejects.toBeInstanceOf(ProjectionPendingError);
        const claims = await Promise.all([
          background.projections.claimContinuation(),
          fresh(accepts()).projections.claimContinuation(),
        ]);
        expect(claims).toEqual([undefined, undefined]);
        await eligible(state.generation);
        // The new lease finalizes B; a delayed rejection from its former owner cannot undo it.
        await background.worker.tick();
        finish(false);
        await expect(running).rejects.toBeInstanceOf(ProjectionPendingError);
        await activeIs(background.client, b.job.indexAttemptId);
        expect(
          await background.client.vectorProjection.findUniqueOrThrow({
            where: {
              reelId_generation: { reelId, generation: state.generation },
            },
          }),
        ).toMatchObject({ publicationPhase: 'FINALIZED', continuation: null });
      });
      it('preserves a newer accepted winner when an older activation and callback finish late', async () => {
        const { b, identity } = await crashAfterActivation();
        const c = candidate();
        await persist(c);
        await drain();
        const winner = fresh(accepts());
        await winner.commit.execute(command(c));
        const stale = fresh({
          isIndexingAttemptCurrent: jest.fn().mockResolvedValue(false),
          completeIndexing: jest.fn().mockResolvedValue(false),
        });
        await stale.candidates.rollbackCandidate(identity);
        await stale.candidates.finalizeCandidate(identity);
        await stale.candidates.discardCandidate(identity);
        await expect(stale.commit.execute(command(b))).rejects.toThrow(
          'superseded',
        );
        await activeIs(winner.client, c.job.indexAttemptId);
      });
      it('fences older callbacks after a newer generation of the same attempt is accepted', async () => {
        await acceptedA();
        const b = candidate();
        const first = await persist(b);
        const obsolete = {
          reelId,
          indexAttemptId: b.job.indexAttemptId,
          projectionGeneration: first.generation.toString(),
          publicationToken: 'obsolete-owner',
        };
        const second = await persist(b);
        expect(second.generation).toBeGreaterThan(first.generation);
        await drain();
        const winner = fresh(accepts());
        await winner.commit.execute(command(b));
        await lifecycle.rollbackCandidate(obsolete);
        await lifecycle.finalizeCandidate(obsolete);
        await lifecycle.discardCandidate(obsolete);
        await expect(
          projection.complete(
            reelId,
            b.job.indexAttemptId,
            first.generation.toString(),
            obsolete.publicationToken,
          ),
        ).rejects.toBeInstanceOf(ProjectionPendingError);
        await activeIs(winner.client, b.job.indexAttemptId);
        expect(
          await winner.client.vectorProjection.findUniqueOrThrow({
            where: {
              reelId_generation: { reelId, generation: second.generation },
            },
          }),
        ).toMatchObject({
          publicationPhase: 'FINALIZED',
          continuation: null,
          revoked: false,
        });
      });
      it('recovers SQL-only publication while Qdrant projection and publication stay disabled', async () => {
        const { a, b, state } = await crashAfterActivation();
        config.set('INDEX_VECTOR_PROJECTION_ENABLED', 'false');
        config.set('INDEX_VECTOR_PUBLICATION_REQUIRED', 'false');
        const identity = jest.spyOn(store, 'identity');
        try {
          const failed = fresh({
            isIndexingAttemptCurrent: jest.fn().mockResolvedValue(true),
            completeIndexing: jest
              .fn()
              .mockRejectedValue(new Error('RPC unavailable')),
          });
          await failed.worker.tick();
          await activeIs(failed.client, a.input.job.indexAttemptId);
          await eligible(state.generation);
          const recovered = fresh(accepts());
          await recovered.worker.tick();
          await activeIs(recovered.client, b.job.indexAttemptId);
          expect(identity).not.toHaveBeenCalled();
        } finally {
          config.set('INDEX_VECTOR_PROJECTION_ENABLED', 'true');
          config.set('INDEX_VECTOR_PUBLICATION_REQUIRED', 'true');
        }
      });
    });
    it('invalidates readiness on restore epoch and recertifies current SQL manifests', async () => {
      await drain();
      await projection.invalidate();
      const search = jest.spyOn(store, 'search');
      expect(await repository.searchReels(query())).toHaveLength(1);
      expect(search).not.toHaveBeenCalled();
      await expect(projection.target()).rejects.toBeInstanceOf(
        ProjectionPendingError,
      );
      await projection.resumeAfterRestore();
      await projection.reconcile();
      await drain();
      expect(await repository.searchReels(query())).toHaveLength(1);
      expect(search).toHaveBeenCalled();
      search.mockRestore();
    });
    it('exports immutable artifacts, resumes imports, and rejects corrupt batches', async () => {
      const { exportSnapshot, importSnapshot, targetFingerprint } =
        migrationModule as {
          exportSnapshot: (
            ...args: unknown[]
          ) => Promise<{ counts: Record<string, number> }>;
          importSnapshot: (
            ...args: unknown[]
          ) => Promise<{ projected: number }>;
          targetFingerprint: (url: string) => string;
        };
      const source = targetFingerprint(
        process.env.REEL_INDEXING_TEST_DATABASE_URL,
      );
      const artifact = join(directory, 'export');
      const result = await exportSnapshot(prisma, projection, artifact, source);
      expect(result.counts).toEqual({
        REEL: 1,
        SECTION: 1,
        CHUNK: 1,
        VISUAL_SCENE: 1,
      });
      await expect(
        exportSnapshot(prisma, projection, artifact, source),
      ).rejects.toThrow();
      const dryReceipts = join(directory, 'dry-receipts');
      expect(
        (
          await importSnapshot(
            prisma,
            projection,
            store,
            artifact,
            source,
            dryReceipts,
            true,
          )
        ).projected,
      ).toBe(4);
      expect(existsSync(dryReceipts)).toBe(false);
      const receipts = join(directory, 'receipts');
      expect(
        (
          await importSnapshot(
            prisma,
            projection,
            store,
            artifact,
            source,
            receipts,
          )
        ).projected,
      ).toBe(4);
      expect(
        (
          await importSnapshot(
            prisma,
            projection,
            store,
            artifact,
            source,
            receipts,
          )
        ).projected,
      ).toBe(4);
      const bytes = readFileSync(join(artifact, 'batch-000000.json'));
      writeFileSync(join(artifact, 'batch-000000.json'), '[]');
      await expect(
        importSnapshot(prisma, projection, store, artifact, source, receipts),
      ).rejects.toThrow('checksum');
      writeFileSync(join(artifact, 'batch-000000.json'), bytes);
    });
    it('backs up encrypted snapshots and restores with maintenance held until explicit replay', async () => {
      const { backup, restore } = backupModule as {
        backup: (
          ...args: unknown[]
        ) => Promise<{ offhostVerified: boolean; name: string }>;
        restore: (...args: unknown[]) => Promise<unknown>;
      };
      process.env.QDRANT_URL = config.getOrThrow<string>('QDRANT_URL');
      process.env.QDRANT_API_KEY_FILE = config.getOrThrow<string>(
        'QDRANT_API_KEY_FILE',
      );
      process.env.REEL_INDEXING_DATABASE_URL =
        process.env.REEL_INDEXING_TEST_DATABASE_URL;
      const offhost = join(directory, 'offhost-simulation');
      mkdirSync(offhost);
      const password = Buffer.alloc(32, 7);
      const saved = await backup(
        prisma,
        projection,
        store,
        {
          directory: join(directory, 'backups'),
          'offhost-directory': offhost,
          'local-test': 'true',
          'sql-backup-proof': join(directory, 'export', 'complete.json'),
        },
        password,
      );
      expect(saved.offhostVerified).toBe(false);
      const archive = join(directory, 'backups', saved.name);
      expect(readFileSync(archive).includes(Buffer.from('science'))).toBe(
        false,
      );
      await restore(
        projection,
        store,
        {
          archive,
          'recovery-proof':
            'READERS_POSTGRES_WRITERS_DRAINED_PUBLICATION_DISABLED',
        },
        password,
      );
      await expect(projection.target()).rejects.toBeInstanceOf(
        ProjectionPendingError,
      );
      expect(await repository.searchReels(query())).toHaveLength(1);
      await projection.resumeAfterRestore();
      await projection.reconcile();
      await drain();
      expect(await repository.searchReels(query())).toHaveLength(1);
    });
    it('rejects wrong-tuple payloads and a concurrent scoped SQL change using full fallback', async () => {
      const primary = await repository.searchReels(query());
      const real = store.search.bind(store) as IReelVectorStore['search'];
      const forged = jest
        .spyOn(store, 'search')
        .mockImplementation(async (input) =>
          (await real(input)).map((hit) => ({
            ...hit,
            payload: { ...hit.payload, retrievalHash: 'forged' },
          })),
        );
      expect(await repository.searchReels(query())).toEqual(primary);
      forged.mockRestore();
      const race = jest
        .spyOn(store, 'search')
        .mockImplementation(async (input) => {
          const hits = await real(input);
          await prisma.reelDocument.updateMany({
            where: { reelId, isActive: true },
            data: { retrievalText: 'Changed during read' },
          });
          return hits;
        });
      const changed = await repository.searchReels(query());
      expect(changed[0].retrievalText).toBe('Changed during read');
      race.mockRestore();
    });
    it('retains tombstones beyond SQL deletion and safely replays cleanup after a late upload', async () => {
      const active = await prisma.reelDocument.findFirstOrThrow({
        where: { reelId, isActive: true },
      });
      const state = await prisma.vectorProjection.findFirstOrThrow({
        where: {
          reelId,
          indexAttemptId: active.indexAttemptId,
          revoked: false,
        },
      });
      const points = await prisma.$transaction((tx) =>
        projection.points(tx, reelId, active.indexAttemptId, state.generation),
      );
      const { importSnapshot, targetFingerprint } = migrationModule as {
        importSnapshot: (
          ...args: unknown[]
        ) => Promise<{ projected: number; superseded: number }>;
        targetFingerprint: (url: string) => string;
      };
      const real = store.upsert.bind(store) as IReelVectorStore['upsert'];
      const deletingImport = jest
        .spyOn(store, 'upsert')
        .mockImplementation(async (batch) => {
          await real(batch);
          await repository.deleteReel(reelId);
        });
      const imported = await importSnapshot(
        prisma,
        projection,
        store,
        join(directory, 'export'),
        targetFingerprint(process.env.REEL_INDEXING_TEST_DATABASE_URL!),
        join(directory, 'delete-race-receipts'),
      );
      expect(imported).toMatchObject({ projected: 0, superseded: 4 });
      deletingImport.mockRestore();
      await drain();
      await store.upsert(points.points);
      expect(await repository.searchReels(query())).toEqual([]);
      await expect(persist(candidate())).rejects.toThrow('Deleted Reel');
      await prisma.vectorProjectionTask.updateMany({
        where: { reelId, operation: 'DELETE' },
        data: { completedAt: new Date(0) },
      });
      await projection.reconcile();
      await drain();
      expect(
        (await prisma.vectorReelState.findUniqueOrThrow({ where: { reelId } }))
          .deleted,
      ).toBe(true);
      expect(
        await store.request(`/collections/${collection}/points/count`, 'POST', {
          filter: { must: [{ key: 'reelId', match: { value: reelId } }] },
          exact: true,
        }),
      ).toEqual({ count: 0 });
    });
  },
);
