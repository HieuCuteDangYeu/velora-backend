import { ConfigService } from '@nestjs/config';
import { EvidenceDiversitySelector } from './evidence-diversity-selector';
import { TeiRerankerAdapter } from './tei-reranker.adapter';

describe('TeiRerankerAdapter', () => {
  const candidate = (id: string) =>
    ({
      id,
      reelId: 'reel-1',
      chunkId: id,
      chunkText: `${id} evidence`,
      retrievalText: `${id} evidence`,
      evidenceText: `${id} evidence`,
      title: 'title',
      description: 'description',
      tags: [],
      score: 0.5,
      vectorScore: 0.5,
      keywordScore: 0,
      metadataScore: 0,
    }) as never;

  afterEach(() => jest.restoreAllMocks());

  it('maps TEI ranking indexes back to original candidates', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          { index: 1, score: 0.9 },
          { index: 0, score: 0.2 },
        ]),
        { status: 200 },
      ),
    );
    const adapter = new TeiRerankerAdapter(
      new ConfigService({ TEI_RERANKER_BASE_URL: 'http://rag-reranker:80' }),
      new EvidenceDiversitySelector(new ConfigService()),
    );

    await expect(
      adapter.rerank({
        queryText: 'query',
        candidates: [candidate('a'), candidate('b')],
        limit: 2,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: 'b', rerankScore: 0.9 }),
      expect.objectContaining({ id: 'a', rerankScore: 0.2 }),
    ]);
  });

  it('fails closed when TEI is unavailable', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));
    const adapter = new TeiRerankerAdapter(
      new ConfigService({ TEI_RERANKER_BASE_URL: 'http://rag-reranker:80' }),
    );

    await expect(
      adapter.rerank({
        queryText: 'query',
        candidates: [candidate('a'), candidate('b')],
        limit: 1,
      }),
    ).rejects.toThrow('offline');
  });
});
