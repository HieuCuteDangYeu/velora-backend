import type {
  IReelVectorStore,
  ReelVectorPayload,
  ReelVectorPoint,
  VectorTarget,
  VectorTuple,
} from '@indexing/domain/interfaces/reel-vector-store.interface';
import {
  normalizedVector,
  validateVector,
  VECTOR_TOLERANCE,
  vectorHash,
} from '@indexing/domain/services/reel-vector-manifest';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';

const MAX_BYTES = 4 * 1024 * 1024;
const BATCH = 128;
export const QDRANT_PAYLOAD_INDEXES = [
  'kind',
  'reelId',
  'indexAttemptId',
  'projectionGeneration',
  'manifestHash',
  'userId',
  'parentId',
  'indexVersion',
  'embeddingProvider',
  'embeddingModel',
  'embeddingVersion',
  'tags',
  'sourceLengthClass',
];
export function tupleFilter(tuple: VectorTuple): { must: unknown[] } {
  return {
    must: Object.entries(tuple).map(([key, value]: [string, unknown]) => ({
      key,
      match: { value },
    })),
  };
}

@Injectable()
export class QdrantReelVectorStoreAdapter implements IReelVectorStore {
  constructor(private readonly config: ConfigService) {}
  get collection(): string {
    const name =
      this.config.get<string>('QDRANT_COLLECTION') ||
      'velora_reel_bge_m3_1024_v1';
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(name))
      throw new Error('Invalid Qdrant collection');
    return name;
  }
  get alias(): string {
    return 'velora_reel_semantic';
  }

  // Explicit operator operation; application startup never creates or repoints collections.
  async initialize(): Promise<void> {
    const exists = await this.request<{ exists: boolean }>(
      `/collections/${this.collection}/exists`,
      'GET',
    );
    if (!exists.exists)
      await this.request(`/collections/${this.collection}`, 'PUT', {
        vectors: {
          size: 1024,
          distance: 'Cosine',
          datatype: 'float32',
          memory: 'cached',
        },
        payload: { memory: 'cached' },
        shard_number: 1,
        replication_factor: 1,
        hnsw_config: {
          m: 16,
          ef_construct: 100,
          memory: 'cached',
          max_indexing_threads: 1,
        },
        optimizers_config: {
          default_segment_number: 1,
          max_optimization_threads: 1,
        },
      });
    for (const field of QDRANT_PAYLOAD_INDEXES)
      await this.request(
        `/collections/${this.collection}/index?wait=true`,
        'PUT',
        { field_name: field, field_schema: 'keyword' },
      );
    const aliases = await this.request<{
      aliases: { alias_name: string; collection_name: string }[];
    }>('/aliases', 'GET');
    const existing = aliases.aliases.find((a) => a.alias_name === this.alias);
    if (existing && existing.collection_name !== this.collection)
      throw new Error('Qdrant alias repoint requires a drained restore');
    if (!existing)
      await this.request('/collections/aliases', 'POST', {
        actions: [
          {
            create_alias: {
              collection_name: this.collection,
              alias_name: this.alias,
            },
          },
        ],
      });
    await this.identity();
  }

  async identity(signal?: AbortSignal): Promise<VectorTarget> {
    const aliases = await this.request<{
      aliases: { alias_name: string; collection_name: string }[];
    }>('/aliases', 'GET', undefined, signal);
    if (
      !aliases.aliases?.some(
        (a) =>
          a.alias_name === this.alias && a.collection_name === this.collection,
      )
    )
      throw new Error('Qdrant alias identity mismatch');
    const info = await this.request<{
      created_at?: string;
      status: string;
      config: {
        params: {
          vectors: { size: number; distance: string; datatype?: string };
        };
        quantization_config?: unknown;
      };
    }>(`/collections/${this.collection}`, 'GET', undefined, signal);
    const vectors = info.config?.params?.vectors;
    if (
      !info.created_at ||
      info.status !== 'green' ||
      vectors?.size !== 1024 ||
      vectors.distance !== 'Cosine' ||
      (vectors.datatype && vectors.datatype !== 'float32') ||
      info.config.quantization_config
    )
      throw new Error('Qdrant collection is not ready or compatible');
    return {
      collection: this.collection,
      fingerprint: vectorHash([
        this.collection,
        info.created_at,
        vectors.size,
        vectors.distance,
      ]),
    };
  }

  async upsert(points: ReelVectorPoint[]): Promise<void> {
    for (let i = 0; i < points.length; i += BATCH) {
      const batch = points.slice(i, i + BATCH);
      batch.forEach((point) => validateVector(point.vector));
      const result = await this.request<{ status: string }>(
        `/collections/${this.collection}/points?wait=true&ordering=strong`,
        'PUT',
        { points: batch },
      );
      if (result.status !== 'completed')
        throw new Error('Qdrant write was not completed');
    }
  }
  async retrieve(
    pointIds: string[],
    signal?: AbortSignal,
  ): Promise<ReelVectorPoint[]> {
    if (new Set(pointIds).size !== pointIds.length)
      throw new Error('Duplicate Qdrant point ID');
    const points: ReelVectorPoint[] = [];
    for (let i = 0; i < pointIds.length; i += BATCH) {
      const ids = pointIds.slice(i, i + BATCH);
      const actual = await this.request<ReelVectorPoint[]>(
        `/collections/${this.collection}/points`,
        'POST',
        { ids, with_payload: true, with_vector: true },
        signal,
      );
      if (
        !Array.isArray(actual) ||
        actual.length !== ids.length ||
        new Set(actual.map((point) => point.id)).size !== ids.length ||
        actual.some(
          (point) =>
            !ids.includes(point.id) ||
            !point.payload ||
            !Array.isArray(point.vector),
        )
      )
        throw new Error('Qdrant point retrieval mismatch');
      actual.forEach((point) => validateVector(point.vector));
      points.push(...actual);
    }
    return points;
  }
  async verify(points: ReelVectorPoint[]): Promise<void> {
    if (!points.length) throw new Error('Cannot certify an empty candidate');
    const tuple = points[0].payload;
    const count = await this.request<{ count: number }>(
      `/collections/${this.collection}/points/count`,
      'POST',
      {
        filter: tupleFilter({
          reelId: tuple.reelId,
          indexAttemptId: tuple.indexAttemptId,
          projectionGeneration: tuple.projectionGeneration,
          manifestHash: tuple.manifestHash,
        }),
        exact: true,
      },
    );
    if (count.count !== points.length)
      throw new Error('Qdrant projection coverage mismatch');
    for (let i = 0; i < points.length; i += BATCH) {
      const batch = points.slice(i, i + BATCH);
      const actual = await this.request<ReelVectorPoint[]>(
        `/collections/${this.collection}/points`,
        'POST',
        { ids: batch.map((p) => p.id), with_payload: true, with_vector: true },
      );
      if (
        !Array.isArray(actual) ||
        actual.length !== batch.length ||
        new Set(actual.map((p) => p.id)).size !== batch.length
      )
        throw new Error('Qdrant point set mismatch');
      for (const expected of batch) {
        const point = actual.find((p) => p.id === expected.id);
        if (
          !point?.payload ||
          Object.entries(expected.payload).some(
            ([key, value]) =>
              JSON.stringify(point.payload[key]) !== JSON.stringify(value),
          )
        )
          throw new Error('Qdrant provenance mismatch');
        const normalized = normalizedVector(expected.vector);
        if (
          !Array.isArray(point.vector) ||
          point.vector.length !== 1024 ||
          point.vector.some(
            (v, j) =>
              !Number.isFinite(v) ||
              Math.abs(v - normalized[j]) > VECTOR_TOLERANCE,
          )
        )
          throw new Error('Qdrant vector mismatch');
      }
    }
  }
  async remove(tuple: VectorTuple): Promise<void> {
    const result = await this.request<{ status: string }>(
      `/collections/${this.collection}/points/delete?wait=true&ordering=strong`,
      'POST',
      { filter: tupleFilter(tuple) },
    );
    if (result.status !== 'completed')
      throw new Error('Qdrant delete was not completed');
  }
  async search(
    input: Parameters<IReelVectorStore['search']>[0],
  ): ReturnType<IReelVectorStore['search']> {
    if (!input.tuples.length || !input.pointIds.length) return [];
    validateVector(input.vector);
    const result = await this.request<{
      points: { id: string; score: number; payload: ReelVectorPayload }[];
    }>(
      `/collections/${this.collection}/points/query`,
      'POST',
      {
        query: input.vector,
        params: { exact: true },
        limit: input.limit,
        with_payload: true,
        with_vector: false,
        filter: {
          must: [
            { has_id: input.pointIds },
            { key: 'kind', match: { value: input.kind } },
            { should: input.tuples.map(tupleFilter) },
          ],
        },
      },
      input.signal,
    );
    if (
      !Array.isArray(result.points) ||
      result.points.length > input.limit ||
      new Set(result.points.map((p) => p.id)).size !== result.points.length ||
      result.points.some(
        (p, i) =>
          typeof p.id !== 'string' ||
          !Number.isFinite(p.score) ||
          p.score < -1.00002 ||
          p.score > 1.00002 ||
          !p.payload ||
          (i > 0 && p.score > result.points[i - 1].score),
      )
    )
      throw new Error('Invalid Qdrant search response');
    return result.points;
  }
  async restoreSnapshot(bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength > 128 * 1024 * 1024)
      throw new Error('Snapshot exceeds byte limit');
    const form = new FormData();
    form.append('snapshot', new Blob([Buffer.from(bytes)]), 'restore.snapshot');
    await this.request(
      `/collections/${this.collection}/snapshots/upload?priority=snapshot&wait=true`,
      'POST',
      form,
    );
  }
  async request<T = unknown>(
    path: string,
    method: string,
    body?: unknown,
    signal?: AbortSignal,
    raw = false,
  ): Promise<T> {
    const base = new URL(
      this.config.get<string>('QDRANT_URL') || 'https://qdrant:6333',
    );
    if (
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      base.pathname !== '/' ||
      (base.protocol !== 'https:' &&
        !(
          this.config.get<string>('QDRANT_ALLOW_LOCAL_HTTP') === 'true' &&
          base.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
        ))
    )
      throw new Error('Qdrant requires verified TLS');
    const secretPath = this.config.get<string>('QDRANT_API_KEY_FILE');
    if (!secretPath)
      throw new Error('Qdrant service-specific API key file required');
    const key = readFileSync(secretPath, 'utf8').trim();
    if (!key || key.length > 4096 || /[\r\n]/.test(key))
      throw new Error('Invalid Qdrant credential file');
    const data =
      body instanceof FormData
        ? body
        : body === undefined
          ? undefined
          : JSON.stringify(body);
    if (typeof data === 'string' && Buffer.byteLength(data) > MAX_BYTES)
      throw new Error('Qdrant request exceeds byte limit');
    const deadline = AbortSignal.timeout(5000);
    const response = await fetch(new URL(path, base), {
      method,
      headers: {
        'api-key': key,
        ...(data instanceof FormData
          ? {}
          : { 'content-type': 'application/json' }),
      },
      body: data,
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Qdrant HTTP ${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty Qdrant response');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > MAX_BYTES)
          throw new Error('Qdrant response exceeds byte limit');
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
    }
    const content = Buffer.concat(chunks).toString('utf8');
    if (raw) return content as T;
    const parsed = JSON.parse(content) as {
      result: T;
      status: string;
    };
    if (parsed.status !== 'ok' || parsed.result === undefined)
      throw new Error('Invalid Qdrant envelope');
    return parsed.result;
  }
}
