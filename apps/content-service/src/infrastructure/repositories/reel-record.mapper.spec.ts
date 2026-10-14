import { toReelDomain } from './reel-record.mapper';

describe('Legacy Reel playback metadata', () => {
  it('keeps an already completed imported HLS playlist playable', () => {
    const reel = toReelDomain({
      id: 'legacy',
      mediaStatus: 'COMPLETED',
      mediaKey: 'https://cdn.test/legacy.m3u8?token=fixture',
    });
    expect(reel.hlsMasterKey).toBe(
      'https://cdn.test/legacy.m3u8?token=fixture',
    );
  });
  it.each(['PENDING', 'COMPLETED'])(
    'does not turn an original file into HLS for %s media',
    (mediaStatus) => {
      expect(
        toReelDomain({
          id: 'reel',
          mediaStatus,
          mediaKey: 'reels/owner/source.mp4',
        }).hlsMasterKey,
      ).toBeUndefined();
    },
  );
});
