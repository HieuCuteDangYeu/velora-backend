import { rewriteHlsPlaylistReferences } from './prepare-existing-hls-evidence.use-case';

describe('rewriteHlsPlaylistReferences', () => {
  it('resolves relative nested playlists against the stored master key', () => {
    const result = rewriteHlsPlaylistReferences(
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n0/stream.m3u8\n',
      'reels/reel-1/media-1/master.m3u8',
      (key) => `https://cdn.example/${key}`,
    );

    expect(result).toContain(
      'https://cdn.example/reels/reel-1/media-1/0/stream.m3u8',
    );
  });

  it('rewrites relative URI attributes while preserving absolute references', () => {
    const result = rewriteHlsPlaylistReferences(
      '#EXT-X-MEDIA:URI="audio/stream.m3u8"\nhttps://cdn.example/video.m3u8\n',
      'reels/reel-1/master.m3u8',
      (key) => `https://cdn.example/${key}`,
    );

    expect(result).toContain(
      'URI="https://cdn.example/reels/reel-1/audio/stream.m3u8"',
    );
    expect(result).toContain('https://cdn.example/video.m3u8');
  });
});
