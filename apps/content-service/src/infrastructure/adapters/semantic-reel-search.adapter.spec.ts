import { of, throwError } from 'rxjs';
import { SemanticReelSearchAdapter } from './semantic-reel-search.adapter';

const hit = (reelId: string, extra: Record<string, unknown> = {}) => ({
  reelId,
  rrfScore: 0.016,
  ...extra,
});
const vector = {
  values: [0.1, 0.2],
  model: 'BAAI/bge-m3',
  version: 'bge-m3-tei-v1',
  dimensions: 2,
};

describe('SemanticReelSearchAdapter', () => {
  const build = (
    reels: unknown[],
    chunks: unknown[] | Error,
    embed?: jest.Mock,
  ) => {
    const send = jest.fn((pattern: string) =>
      pattern === 'index.search_chunks'
        ? chunks instanceof Error
          ? throwError(() => chunks)
          : of(chunks)
        : of(reels),
    );
    const adapter = new SemanticReelSearchAdapter(
      { send } as never,
      embed ? { generateEmbedding: embed } : undefined,
    );
    return { adapter, send };
  };

  it('sends the query vector and keeps only close vector-only reel matches', async () => {
    const embed = jest.fn().mockResolvedValue(vector);
    const { adapter, send } = build(
      [
        hit('near', { vectorDistance: 0.45 }),
        hit('far', { vectorDistance: 0.62 }),
        hit('keyword-far', { vectorDistance: 0.7, keywordRank: 1 }),
        hit('keyword-only'),
      ],
      [],
      embed,
    );
    const found = await adapter.searchPublicReels({
      query: 'a river',
      limit: 8,
    });
    expect(found.map((c) => c.reelId)).toEqual([
      'near',
      'keyword-far',
      'keyword-only',
    ]);
    expect(send.mock.calls[0][1]).toMatchObject({
      queryText: 'a river',
      queryEmbedding: vector.values,
      queryEmbeddingModel: 'BAAI/bge-m3',
    });
  });

  it('adds reels whose transcript chunks are close to the query, best agreement first', async () => {
    const embed = jest.fn().mockResolvedValue(vector);
    const { adapter } = build(
      [
        hit('title-match', { vectorDistance: 0.4 }),
        hit('both', { vectorDistance: 0.5 }),
      ],
      [
        hit('both', { vectorDistance: 0.3 }),
        hit('both', { vectorDistance: 0.32 }),
        hit('spoken-only', { vectorDistance: 0.36 }),
        hit('unrelated', { vectorDistance: 0.52 }),
      ],
      embed,
    );
    const found = await adapter.searchPublicReels({ query: 'x', limit: 8 });
    expect(found.map((c) => c.reelId)).toEqual([
      'both',
      'title-match',
      'spoken-only',
    ]);
  });

  it('asks for more candidates than the caller wants, since private reels are dropped later', async () => {
    const embed = jest.fn().mockResolvedValue(vector);
    const { adapter, send } = build([], [], embed);
    await adapter.searchPublicReels({ query: 'x', limit: 8 });
    expect(send.mock.calls[0][1]).toMatchObject({ limit: 24 });
  });

  it('still returns reel matches when the chunk search fails', async () => {
    const embed = jest.fn().mockResolvedValue(vector);
    const { adapter } = build(
      [hit('near', { vectorDistance: 0.4 })],
      new Error('qdrant timeout'),
      embed,
    );
    await expect(
      adapter.searchPublicReels({ query: 'x', limit: 8 }),
    ).resolves.toEqual([expect.objectContaining({ reelId: 'near' })]);
  });

  it('falls back to a keyword-only reel search when the embedder fails', async () => {
    const embed = jest.fn().mockRejectedValue(new Error('embedder down'));
    const { adapter, send } = build([hit('kw')], [], embed);
    await expect(
      adapter.searchPublicReels({ query: 'x', limit: 8 }),
    ).resolves.toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).not.toHaveProperty('queryEmbedding');
  });

  it('works without an embedding service at all', async () => {
    const { adapter } = build([hit('kw')], []);
    await expect(
      adapter.searchPublicReels({ query: 'x', limit: 8 }),
    ).resolves.toHaveLength(1);
  });
});
