'use strict';

const { fingerprint } = require('./rag-evaluation-contract.cjs');

// Evaluation-only frozen backend replay. Similarity ranking here is lexical;
// this does not measure live TEI/Postgres vector retrieval or owner-service ACLs.
function createFixturePorts(fixture) {
  const allowed = new Set(fixture.authorizedReelIds || []);
  const documents = new Map(
    (fixture.documents || []).map((d) => [d.reelId, d]),
  );
  const events = [];
  let injectedCalls = 0;
  function fault(stage) {
    if (fixture.fault?.stage !== stage) return;
    const type = fixture.fault.type;
    if (
      ['EMPTY', 'STALE_VERSION', 'OVERSIZED', 'IDENTITY_MISMATCH'].includes(
        type,
      )
    )
      return;
    if (fixture.fault.variant === 'PRIMARY' && injectedCalls++ > 0) return;
    const error = Object.assign(
      new Error(`Isolated fixture ${stage}: ${type}`),
      {
        code:
          type === 'HTTP_429'
            ? 'GROQ_KEY_POOL_EXHAUSTED'
            : type === 'TIMEOUT'
              ? 'ETIMEDOUT'
              : 'FIXTURE_INVALID_RESPONSE',
        httpStatus: type === 'HTTP_429' ? 429 : undefined,
      },
    );
    events.push({ stage, type, injected: true });
    throw error;
  }
  const toResult = (row, evidenceType) => {
    const doc = documents.get(row.reelId);
    return {
      ...row,
      userId: row.userId || 'fixture-source-owner',
      ordinal: row.ordinal || 0,
      parentId: row.parentId || doc?.id,
      title: row.title || doc?.title,
      description: row.description || doc?.description,
      evidenceType,
      text: row.retrievalText || row.evidenceText || row.title || '',
      retrievalText: row.retrievalText || row.evidenceText || row.title || '',
      tags: row.tags || doc?.tags || [],
      sourceDurationMs: row.sourceDurationMs || doc?.sourceDurationMs || 120000,
      sourceOrientation:
        row.sourceOrientation || doc?.sourceOrientation || 'PORTRAIT',
      sourceLengthClass:
        row.sourceLengthClass || doc?.sourceLengthClass || 'SHORT',
      rrfScore: 1,
    };
  };
  function search(rows, type, input = {}) {
    fault('index');
    if (fixture.fault?.stage === 'index' && fixture.fault.type === 'EMPTY') {
      events.push({ stage: 'index', type: 'EMPTY', injected: true });
      return [];
    }
    if (
      input.queryEmbeddingModel &&
      input.queryEmbeddingModel !== 'BAAI/bge-m3'
    )
      return [];
    if (
      input.queryEmbeddingVersion &&
      input.queryEmbeddingVersion !== 'bge-m3-tei-v1'
    )
      return [];
    const terms =
      String(input.queryText || '')
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) || [];
    const score = (r) =>
      terms.reduce(
        (n, t) =>
          n +
          Number(
            String(r.evidenceText || r.title || '')
              .toLowerCase()
              .includes(t),
          ),
        0,
      );
    const selected = rows.filter((r) => {
      const doc = documents.get(r.reelId);
      return (
        allowed.has(r.reelId) &&
        doc &&
        (!r.indexAttemptId || r.indexAttemptId === doc.indexAttemptId) &&
        (!input.requiredIndexVersion ||
          r.indexVersion === input.requiredIndexVersion) &&
        (!input.filters?.reelIds || input.filters.reelIds.includes(r.reelId)) &&
        (!input.filters?.parentIds ||
          input.filters.parentIds.includes(r.parentId || doc.id)) &&
        !(input.excludedIds || []).includes(r.id) &&
        (input.sourceTimestampSec == null ||
          (input.sourceTimestampEndSec != null
            ? (r.startTime ?? 0) <= input.sourceTimestampEndSec &&
              (r.endTime ?? 0) >= input.sourceTimestampSec
            : (r.startTime ?? 0) <= input.sourceTimestampSec &&
              (r.endTime ?? 0) >= input.sourceTimestampSec))
      );
    });
    selected.sort(
      input.sourceOrder === 'ASC'
        ? (a, b) => {
            if (
              input.sourceTimestampEndSec != null &&
              input.sourceTimestampSec != null
            ) {
              const aCovers =
                (a.startTime ?? 0) <= input.sourceTimestampSec &&
                (a.endTime ?? 0) >= input.sourceTimestampEndSec;
              const bCovers =
                (b.startTime ?? 0) <= input.sourceTimestampSec &&
                (b.endTime ?? 0) >= input.sourceTimestampEndSec;
              if (aCovers !== bCovers) return aCovers ? -1 : 1;
              if ((a.endTime ?? 0) !== (b.endTime ?? 0))
                return (b.endTime ?? 0) - (a.endTime ?? 0);
            }
            return (
              (a.startTime ?? 0) - (b.startTime ?? 0) ||
              a.id.localeCompare(b.id)
            );
          }
        : (a, b) => score(b) - score(a) || a.id.localeCompare(b.id),
    );
    events.push({
      stage: 'index',
      type,
      returned: Math.min(selected.length, input.limit || 8),
    });
    return selected.slice(0, input.limit || 8).map((r) => {
      const result = toResult(r, type);
      if (
        fixture.fault?.stage === 'index' &&
        fixture.fault.type === 'STALE_VERSION'
      )
        result.indexVersion = 'stale-fixture-version';
      if (
        fixture.fault?.stage === 'context' &&
        fixture.fault.type === 'OVERSIZED'
      )
        result.evidenceText =
          result.text =
          result.retrievalText =
            result.evidenceText.repeat(10000);
      if (
        fixture.fault?.stage === 'index' &&
        fixture.fault.type === 'STALE_VERSION'
      )
        events.push({ stage: 'index', type: 'STALE_VERSION', injected: true });
      if (
        fixture.fault?.stage === 'context' &&
        fixture.fault.type === 'OVERSIZED'
      )
        events.push({ stage: 'context', type: 'OVERSIZED', injected: true });
      return result;
    });
  }
  const forbiddenWrite = async () => {
    throw new Error('Evaluation fixture writes are disabled');
  };
  return {
    events,
    fault,
    fixtureFault: fixture.fault,
    content: {
      async resolveReelContextAccess({ userId, conversationId }) {
        return userId === fixture.userId &&
          conversationId === fixture.conversationId
          ? [...allowed]
          : [];
      },
      async searchPublicReels({ query, viewerId, limit = 6 }) {
        const terms =
          String(query ?? '')
            .toLowerCase()
            .match(/[\p{L}\p{N}]+/gu) ?? [];
        return viewerId === fixture.userId
          ? (fixture.recommendations || [])
              .filter((r) => {
                const searchable =
                  `${r.title} ${r.tags.join(' ')}`.toLowerCase();
                return (
                  r.visibility === 'public' &&
                  terms.some((term) => searchable.includes(term))
                );
              })
              .slice(0, limit)
          : [];
      },
      async getRecommendedReels({ viewerId, limit = 6 }) {
        return viewerId === fixture.userId
          ? (fixture.recommendations || [])
              .filter((r) => r.visibility === 'public')
              .slice(0, limit)
          : [];
      },
    },
    index: {
      async searchReels(input) {
        return search([...documents.values()], 'METADATA', input);
      },
      async searchSections(input) {
        return search(fixture.sections || [], 'TRANSCRIPT', input);
      },
      async searchChunks(input) {
        return search(fixture.chunks || [], 'TRANSCRIPT', input);
      },
      async searchVisualScenes(input) {
        return search(fixture.scenes || [], 'VISUAL', input);
      },
      async getAdjacentChunks(input) {
        return search(fixture.chunks || [], 'TRANSCRIPT', {
          filters: {
            reelIds: input.eligibleReelIds,
            parentIds: [input.parentId],
          },
          requiredIndexVersion: input.requiredIndexVersion,
          excludedIds: [input.chunkId],
          sourceOrder: 'ASC',
          limit: input.limit,
        });
      },
      async getReelDocument(reelId) {
        fault('index');
        const doc = allowed.has(reelId) ? documents.get(reelId) : null;
        return doc
          ? {
              ...doc,
              userId: 'fixture-source-owner',
              text: doc.description || doc.title,
              sourceDurationMs: doc.sourceDurationMs || 120000,
              sourceLengthClass: doc.sourceLengthClass || 'SHORT',
              sourceOrientation: doc.sourceOrientation || 'PORTRAIT',
              embeddingProvider: 'tei',
              embeddingModel: 'BAAI/bge-m3',
              embeddingDimensions: 1024,
              embeddingVersion: 'bge-m3-tei-v1',
              chunkingVersion: 'fixture',
              summaryVersion: 'fixture',
              createdAt: '2026-10-06T00:00:00.000Z',
              updatedAt: '2026-10-06T00:00:00.000Z',
            }
          : null;
      },
    },
    userMemory: {
      async getEmbeddingDimensions() {
        return 1024;
      },
      async findByUserId(userId, limit) {
        return (fixture.userMemories || [])
          .filter((m) => m.userId === userId)
          .slice(0, limit);
      },
      async findRelevantByUserId(input) {
        return (await this.findByUserId(input.userId, input.limit)).filter(
          (m) =>
            m.confidence == null || m.confidence >= (input.minConfidence || 0),
        );
      },
      async markUsed() {},
      upsertMany: forbiddenWrite,
      replaceSimilar: forbiddenWrite,
      updateEmbedding: forbiddenWrite,
      findWithoutEmbedding: forbiddenWrite,
    },
    conversationMemory: {
      async findByConversationId(id) {
        const m = (fixture.conversationMemories || []).find(
          (x) => x.conversationId === id,
        );
        return m
          ? {
              ...m,
              userId: fixture.userId,
              updatedAt: new Date('2026-10-06T00:00:00Z'),
            }
          : null;
      },
      upsert: forbiddenWrite,
    },
  };
}

function runtimeInput(row, fixture) {
  if (
    row.input.fixtureRef !== row.id ||
    fingerprint(fixture) !== row.metadata.fixtureSha256
  )
    throw new Error('Fixture identity mismatch');
  return {
    userId: fixture.userId,
    conversationId: fixture.conversationId,
    message: row.input.question,
    memory: { recentMessages: fixture.recentMessages || [] },
  };
}

module.exports = { createFixturePorts, runtimeInput };
