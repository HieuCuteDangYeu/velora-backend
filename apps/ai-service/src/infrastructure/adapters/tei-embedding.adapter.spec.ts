import { ConfigService } from '@nestjs/config';
import { TeiEmbeddingAdapter } from './tei-embedding.adapter';

describe('TeiEmbeddingAdapter', () => {
  afterEach(() => jest.restoreAllMocks());

  it('maps a normalized TEI vector to the active 1024-dimensional identity', async () => {
    const vector = Array.from({ length: 1024 }, (_, index) =>
      index === 0 ? 1 : 0,
    );
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify([vector]), { status: 200 }),
      );
    const adapter = new TeiEmbeddingAdapter(
      new ConfigService({
        TEI_EMBEDDING_BASE_URL: 'http://rag-embedding:80',
        TEI_EMBEDDING_MODEL: 'BAAI/bge-m3',
        AI_EMBEDDING_DIMENSIONS: '1024',
        AI_EMBEDDING_VERSION: 'bge-m3-tei-v1',
      }),
    );

    await expect(
      adapter.generateVector({ text: 'hello', taskType: 'RETRIEVAL_QUERY' }),
    ).resolves.toMatchObject({
      dimensions: 1024,
      model: 'BAAI/bge-m3',
      provider: 'self-hosted-tei',
      version: 'bge-m3-tei-v1',
      values: vector,
    });
    expect(fetch).toHaveBeenCalledWith(
      'http://rag-embedding:80/embed',
      expect.objectContaining({ method: 'POST' }),
    );
    const requestInit = fetchMock.mock.calls[0]?.[1];
    expect(typeof requestInit?.body).toBe('string');
    expect(JSON.parse(requestInit?.body as string)).toEqual({
      inputs: ['hello'],
      normalize: true,
    });
  });

  it('fails closed on an incompatible vector dimension', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([Array.from({ length: 384 }, () => 1)]), {
        status: 200,
      }),
    );
    const adapter = new TeiEmbeddingAdapter(
      new ConfigService({
        TEI_EMBEDDING_BASE_URL: 'http://rag-embedding:80',
        AI_EMBEDDING_DIMENSIONS: '1024',
        AI_EMBEDDING_VERSION: 'bge-m3-tei-v1',
      }),
    );
    await expect(adapter.generateVector({ text: 'hello' })).rejects.toThrow(
      '1024 finite values',
    );
  });
});
