import { ConfigService } from '@nestjs/config';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { QdrantReelVectorStoreAdapter } from './qdrant-reel-vector-store.adapter';

describe('bounded Qdrant transport trust boundary', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qdrant-transport-'));
  const key = join(directory, 'key');
  beforeAll(() => writeFileSync(key, 'local-test-key', { mode: 0o600 }));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  afterEach(() => jest.restoreAllMocks());
  const store = (url = 'https://qdrant:6333') =>
    new QdrantReelVectorStoreAdapter(
      new ConfigService({
        QDRANT_URL: url,
        QDRANT_API_KEY_FILE: key,
        QDRANT_ALLOW_LOCAL_HTTP: 'true',
      }),
    );
  it('rejects unverified remote HTTP and credential-bearing URLs before sending a request', async () => {
    const transport = jest.spyOn(globalThis, 'fetch');
    for (const url of [
      'http://remote:6333',
      'https://name:password@qdrant:6333',
      'https://qdrant:6333/path',
    ])
      await expect(store(url).request('/aliases', 'GET')).rejects.toThrow(
        'verified TLS',
      );
    expect(transport).not.toHaveBeenCalled();
  });
  it('caps outbound and streamed inbound bytes', async () => {
    const transport = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('x'.repeat(4 * 1024 * 1024 + 1)));
    await expect(
      store().request('/test', 'PUT', { value: 'x'.repeat(4 * 1024 * 1024) }),
    ).rejects.toThrow('request exceeds');
    expect(transport).not.toHaveBeenCalled();
    await expect(store().request('/aliases', 'GET')).rejects.toThrow(
      'response exceeds',
    );
  });
  it('rejects invalid envelopes and incomplete write acknowledgements', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"status":"ok"}'))
      .mockResolvedValueOnce(
        new Response('{"status":"ok","result":{"status":"acknowledged"}}'),
      );
    await expect(store().request('/aliases', 'GET')).rejects.toThrow(
      'envelope',
    );
    await expect(
      store().remove({
        reelId: 'r',
        indexAttemptId: 'a',
        projectionGeneration: '1',
        manifestHash: 'hash',
      }),
    ).rejects.toThrow('not completed');
  });
});
