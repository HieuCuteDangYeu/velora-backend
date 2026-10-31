import {
  makePoint,
  normalizedVector,
  pointManifest,
  validateVector,
  vectorPointId,
} from './reel-vector-manifest';

describe('vector projection identity', () => {
  it('uses a stable, unambiguous UUID and separates attempts, kinds and generations', () => {
    const id = vectorPointId('REEL', 'a', 'b', '1', 'reel:a');
    expect(id).toBe('cbf73064-3a5b-5daa-b79c-1e2c74928712');
    expect(id).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-5[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
    );
    expect(vectorPointId('REEL', 'a', 'b', '1', 'reel:a')).toBe(id);
    expect(
      new Set([
        id,
        vectorPointId('REEL', 'a', 'b', '2', 'reel:a'),
        vectorPointId('CHUNK', 'a', 'b', '1', 'reel:a'),
        vectorPointId('REEL', 'a', 'c', '1', 'reel:a'),
        vectorPointId('REEL', 'ab', '', '1', 'reel:a'),
      ]).size,
    ).toBe(5);
  });
  it('rejects zero, nonfinite and wrong-dimension vectors', () => {
    for (const vector of [
      [],
      Array<number>(1024).fill(0),
      [NaN, ...Array<number>(1023).fill(1)],
      [Infinity, ...Array<number>(1023).fill(1)],
    ])
      expect(() => validateVector(vector)).toThrow();
    expect(normalizedVector(Array<number>(1024).fill(2))[0]).toBeCloseTo(
      1 / 32,
    );
  });
  it('hashes provenance and float32 vector content without depending on manifest field or row order', () => {
    const row = {
      id: 'reel:a',
      reelId: 'a',
      indexAttemptId: 'b',
      userId: 'u',
      parentId: null,
      ordinal: 0,
      tags: [],
      sourceLengthClass: 'SHORT',
      indexVersion: 'v',
      embeddingProvider: 'tei',
      embeddingModel: 'bge',
      embeddingVersion: 'v',
      embeddingDimensions: 1024,
      embeddingInputHash: 'input',
      retrievalHash: 'text',
      evidenceHash: null,
      embedding: Array<number>(1024).fill(1),
    };
    const point = makePoint('REEL', '1', row);
    const hash = pointManifest([point]);
    point.payload.manifestHash = hash;
    expect(pointManifest([point])).toBe(hash);
    expect(
      pointManifest([
        makePoint('REEL', '1', { ...row, retrievalHash: 'changed' }),
      ]),
    ).not.toBe(hash);
    expect(
      pointManifest([
        makePoint('REEL', '1', {
          ...row,
          embedding: Array<number>(1024).fill(2),
        }),
      ]),
    ).not.toBe(hash);
  });
});
