import { SearchController } from './search.controller';

describe('Search Reel stream readiness', () => {
  const controller = new SearchController(
    {} as never,
    {} as never,
    { getOrThrow: () => 'https://cdn.velora.test' } as never,
    {} as never,
  );
  const enrich = (input: unknown) =>
    (
      controller as unknown as {
        enrichReel(value: unknown): { streamUrl: string };
      }
    ).enrichReel(input);

  it('uses the validated attempt playlist while indexing is still processing', () => {
    const result = enrich({
      id: 'reel',
      userId: 'owner',
      tags: [],
      createdAt: new Date(),
      mediaKey: 'reels/owner/source.mp4',
      hlsMasterKey: 'reels/owner/source/attempt/master.m3u8',
      mediaStatus: 'COMPLETED',
      indexStatus: 'PROCESSING',
    });
    expect(result.streamUrl).toBe(
      'https://cdn.velora.test/reels/owner/source/attempt/master.m3u8',
    );
  });

  it.each(['PENDING', 'FAILED'])(
    'does not invent a stream for %s media',
    (mediaStatus) => {
      const result = enrich({
        id: 'reel',
        userId: 'owner',
        tags: [],
        createdAt: new Date(),
        mediaKey: 'reels/owner/source.mp4',
        mediaStatus,
      });
      expect(result.streamUrl).toBe('');
    },
  );
});
