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

  it('scores late candidates across bounded batches and puts evidence before long metadata', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockImplementation((_url, init) => {
        if (typeof init?.body !== 'string')
          throw new Error('Missing request body');
        const body = JSON.parse(init.body) as { texts: string[] };
        expect(body.texts.every((text) => text.startsWith('decisive'))).toBe(
          true,
        );
        return Promise.resolve(
          new Response(
            JSON.stringify(
              body.texts.map((text, index) => ({
                index,
                score: text.includes('winner') ? 1 : 0.1,
              })),
            ),
            { status: 200 },
          ),
        );
      });
    const adapter = new TeiRerankerAdapter(
      new ConfigService({
        TEI_RERANKER_BASE_URL: 'http://test',
        AI_RAG_NEURAL_RERANK_CANDIDATE_LIMIT: '8',
      }),
    );
    const candidates = Array.from({ length: 8 }, (_, index) => ({
      ...(candidate(String(index)) as object),
      chunkId: String(index),
      reelId: 'reel-1',
      tags: [],
      evidenceText: index === 7 ? 'decisive winner' : 'decisive other',
      chunkText: 'unused',
      title: 'metadata '.repeat(200),
      distance: null,
    }));
    const result = await adapter.rerank({
      queryText: 'question',
      candidates,
      limit: 1,
    });
    expect(result[0].chunkId).toBe('7');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

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

  it('bounds the request to the configured TEI batch-token budget', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockImplementation((_url, init) => {
        const rawBody = (init as RequestInit).body;
        if (typeof rawBody !== 'string')
          throw new Error('missing request body');
        const body = JSON.parse(rawBody) as {
          query: string;
          texts: string[];
        };
        expect(body.texts).toHaveLength(5);
        expect(body.query.split(/\s+/u)).toHaveLength(2);
        expect(
          body.texts.every((text) => text.split(/\s+/u).length <= 138),
        ).toBe(true);
        return Promise.resolve(
          new Response(
            JSON.stringify(
              body.texts.map((_text, index) => ({
                index,
                score: 1 - index / 10,
              })),
            ),
            { status: 200 },
          ),
        );
      });
    const adapter = new TeiRerankerAdapter(
      new ConfigService({
        TEI_RERANKER_BASE_URL: 'http://rag-reranker:80',
        TEI_RERANKER_MAX_BATCH_TOKENS: '1024',
        AI_RAG_NEURAL_RERANK_CANDIDATE_LIMIT: '20',
        AI_RERANKER_MAX_INPUT_TOKENS: '512',
      }),
    );

    await expect(
      adapter.rerank({
        queryText: 'query text',
        candidates: Array.from({ length: 20 }, (_, index) =>
          candidate(String(index)),
        ),
        limit: 5,
      }),
    ).resolves.toHaveLength(5);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('retries when TEI returns 429 overloaded and succeeds', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: 'Model is overloaded',
            error_type: 'Overloaded',
          }),
          { status: 429 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { index: 0, score: 0.8 },
            { index: 1, score: 0.3 },
          ]),
          { status: 200 },
        ),
      );
    const adapter = new TeiRerankerAdapter(
      new ConfigService({
        TEI_RERANKER_BASE_URL: 'http://rag-reranker:80',
        AI_RAG_NEURAL_RERANK_MAX_RETRIES: '2',
      }),
      new EvidenceDiversitySelector(new ConfigService()),
    );

    const result = await adapter.rerank({
      queryText: 'query',
      candidates: [candidate('a'), candidate('b')],
      limit: 2,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('a');
  });
});
