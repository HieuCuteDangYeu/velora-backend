import { resolveReelMediaTrim } from './reel-media-trim';

describe('resolveReelMediaTrim', () => {
  it('uses the complete source interval when trim is absent', () => {
    expect(resolveReelMediaTrim({ framing: 'fit' }, 10_000)).toEqual({
      sourceStartMs: 0,
      sourceEndMs: 10_000,
      outputDurationMs: 10_000,
    });
  });

  it('canonicalizes a valid interval', () => {
    expect(
      resolveReelMediaTrim(
        {
          framing: 'fit',
          trim: { version: 1, startMs: 1250.4, endMs: 5250.6 },
        },
        10_000,
      ),
    ).toEqual({
      sourceStartMs: 1250,
      sourceEndMs: 5251,
      outputDurationMs: 4001,
    });
  });

  it('clamps only a small probe rounding overflow', () => {
    expect(
      resolveReelMediaTrim(
        { framing: 'fit', trim: { version: 1, startMs: 100, endMs: 10_030 } },
        10_000,
      ),
    ).toEqual({
      sourceStartMs: 100,
      sourceEndMs: 10_000,
      outputDurationMs: 9900,
    });
  });

  it.each([
    { startMs: -1, endMs: 2000 },
    { startMs: 9000, endMs: 10_051 },
    { startMs: 0, endMs: 10_100 },
    { startMs: 5000, endMs: 5900 },
  ])('rejects an invalid runtime interval %#', (trim) => {
    expect(() =>
      resolveReelMediaTrim(
        { framing: 'fit', trim: { version: 1, ...trim } },
        10_000,
      ),
    ).toThrow();
  });
});
