import { of } from 'rxjs';
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
  const build = (results: unknown[], embed?: jest.Mock) => {
    const send = jest.fn().mockReturnValue(of(results));
    const adapter = new SemanticReelSearchAdapter(
      { send } as never,
      embed ? { generateEmbedding: embed } : undefined,
    );
    return { adapter, send };
  };

  it('sends the query vector and keeps only close vector-only matches', async () => {
    const embed = jest.fn().mockResolvedValue(vector);
    const { adapter, send } = build(
      [
        hit('near', { vectorDistance: 0.45 }),
        hit('far', { vectorDistance: 0.62 }),
        hit('keyword-far', { vectorDistance: 0.7, keywordRank: 1 }),
        hit('keyword-only'),
      ],
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

  it('falls back to a keyword-only search when the embedder fails', async () => {
    const embed = jest.fn().mockRejectedValue(new Error('embedder down'));
    const { adapter, send } = build([hit('kw')], embed);
    await expect(
      adapter.searchPublicReels({ query: 'x', limit: 8 }),
    ).resolves.toHaveLength(1);
    expect(send.mock.calls[0][1]).not.toHaveProperty('queryEmbedding');
  });

  it('works without an embedding service at all', async () => {
    const { adapter } = build([hit('kw')]);
    await expect(
      adapter.searchPublicReels({ query: 'x', limit: 8 }),
    ).resolves.toHaveLength(1);
  });
});
