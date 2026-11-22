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

  describe('overload handling', () => {
    const config = () =>
      new ConfigService({
        TEI_EMBEDDING_BASE_URL: 'http://rag-embedding:80',
        AI_EMBEDDING_DIMENSIONS: '1024',
        AI_EMBEDDING_OVERLOAD_BACKOFF_MS: '1',
      });
    const vector = Array.from({ length: 1024 }, (_, index) =>
      index === 0 ? 1 : 0,
    );
    const overloaded = () =>
      new Response(
        '{"error":"Model is overloaded","error_type":"Overloaded"}',
        {
          status: 429,
        },
      );

    it('retries a 429 from TEI and succeeds once capacity frees up', async () => {
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(overloaded())
        .mockResolvedValueOnce(overloaded())
        .mockResolvedValueOnce(
          new Response(JSON.stringify([vector]), { status: 200 }),
        );
      const adapter = new TeiEmbeddingAdapter(config());
      await expect(
        adapter.generateVector({ text: 'hello' }),
      ).resolves.toMatchObject({ dimensions: 1024 });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('gives up after the configured number of retries', async () => {
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockImplementation(() => Promise.resolve(overloaded()));
      const adapter = new TeiEmbeddingAdapter(config());
      await expect(adapter.generateVector({ text: 'hello' })).rejects.toThrow(
        'status 429',
      );
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it('does not retry a client error that is not an overload', async () => {
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response('bad request', { status: 400 }));
      const adapter = new TeiEmbeddingAdapter(config());
      await expect(adapter.generateVector({ text: 'hello' })).rejects.toThrow(
        'status 400',
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('retries a request that hit the timeout and gives up after the bounded retries', async () => {
      const aborted = () =>
        Promise.reject(new DOMException('aborted', 'AbortError'));
      jest.useFakeTimers();
      try {
        const fetchMock = jest
          .spyOn(global, 'fetch')
          .mockImplementation((_url, init) => {
            // Mimic the abort the adapter's own timer triggers.
            return new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () =>
                reject(new DOMException('aborted', 'AbortError')),
              );
            });
          });
        void aborted;
        const adapter = new TeiEmbeddingAdapter(config());
        const result = adapter.generateVector({ text: 'hello' });
        const assertion = expect(result).rejects.toThrow('timed out');
        await jest.advanceTimersByTimeAsync(10 * 120_000);
        await assertion;
        expect(fetchMock).toHaveBeenCalledTimes(3);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
