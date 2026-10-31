import {
  isLegacyReelHlsKey,
  isUserOwnedReelMediaKey,
  normalizeReelMediaKey,
} from './reel-media-key';

describe('Reel media key ownership', () => {
  it.each([
    'chat-videos/user-1/source.mp4',
    'chat-videos/user-1/source.quicktime',
    'chat-videos/user-1/source.webm',
    'chat-videos/user-1/source/master.m3u8',
  ])('accepts an owned legacy key: %s', (key) => {
    expect(isUserOwnedReelMediaKey(key, 'user-1')).toBe(true);
  });

  it.each(['reels/user-1/source.mp4', 'reels/user-1/source/master.m3u8'])(
    'accepts an owned modern key: %s',
    (key) => {
      expect(isUserOwnedReelMediaKey(key, 'user-1')).toBe(true);
    },
  );

  it.each([
    'chat-videos/user-2/source.mp4',
    'reels/user-2/source.mp4',
    'chat-videos/user-1/../user-2/source.mp4',
    'chat-videos/user-1/./source.mp4',
    'chat-videos/user-1\\source.mp4',
    'uploads/user-1/source.mp4',
  ])('rejects an unowned or unsafe key: %s', (key) => {
    expect(isUserOwnedReelMediaKey(key, 'user-1')).toBe(false);
  });

  it('normalizes only leading separators and whitespace', () => {
    expect(
      isUserOwnedReelMediaKey(
        normalizeReelMediaKey(' /chat-videos/user-1/source.webm '),
        ' user-1 ',
      ),
    ).toBe(true);
  });
});

describe('legacy stored HLS import keys', () => {
  const reelId = '12345678-1234-1234-1234-123456789abc';
  it('accepts only the canonical stored master for this UUID Reel', () => {
    expect(isLegacyReelHlsKey(`reels/${reelId}/master.m3u8`, reelId)).toBe(
      true,
    );
    expect(
      isLegacyReelHlsKey(`reels/${reelId}/master.m3u8`, 'different-reel'),
    ).toBe(false);
    expect(
      isLegacyReelHlsKey('https://external.example/master.m3u8', reelId),
    ).toBe(false);
    expect(
      isLegacyReelHlsKey(`reels/${reelId}/../other/master.m3u8`, reelId),
    ).toBe(false);
  });
  it('accepts an immutable imported version only for this Reel and only as HLS', () => {
    const key = `reels/${reelId}/87654321-1234-1234-1234-123456789abc/master.m3u8`;
    expect(isLegacyReelHlsKey(key, reelId)).toBe(true);
    expect(isUserOwnedReelMediaKey(key, 'owner')).toBe(false);
    expect(
      isLegacyReelHlsKey(key.replace('master.m3u8', 'source.mp4'), reelId),
    ).toBe(false);
    expect(
      isLegacyReelHlsKey(
        key.replace('87654321-1234-1234-1234-123456789abc', 'arbitrary'),
        reelId,
      ),
    ).toBe(false);
  });
});
