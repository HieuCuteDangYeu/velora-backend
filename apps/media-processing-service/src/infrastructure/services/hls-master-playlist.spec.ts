import { orderHlsMasterVariantsHighestFirst } from './hls-master-playlist';

// The exact master ffmpeg wrote for a 1080x1920 reel on 2026-11-28.
const FFMPEG_MASTER = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-STREAM-INF:BANDWIDTH=930600,RESOLUTION=360x640,CODECS="avc1.4d4028,mp4a.40.2"
0/stream.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=1663200,RESOLUTION=540x960,CODECS="avc1.4d4028,mp4a.40.2"
1/stream.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=2780800,RESOLUTION=720x1280,CODECS="avc1.4d4028,mp4a.40.2"
2/stream.m3u8
`;

describe('orderHlsMasterVariantsHighestFirst', () => {
  it('lists the highest bandwidth variant first so AVPlayer starts on it', () => {
    expect(orderHlsMasterVariantsHighestFirst(FFMPEG_MASTER)).toBe(`#EXTM3U
#EXT-X-VERSION:6
#EXT-X-STREAM-INF:BANDWIDTH=2780800,RESOLUTION=720x1280,CODECS="avc1.4d4028,mp4a.40.2"
2/stream.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=1663200,RESOLUTION=540x960,CODECS="avc1.4d4028,mp4a.40.2"
1/stream.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=930600,RESOLUTION=360x640,CODECS="avc1.4d4028,mp4a.40.2"
0/stream.m3u8
`);
  });

  it('does not confuse AVERAGE-BANDWIDTH with BANDWIDTH', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=9000000,BANDWIDTH=1000',
      'low.m3u8',
      '#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=1,BANDWIDTH=2000',
      'high.m3u8',
    ].join('\n');

    expect(
      orderHlsMasterVariantsHighestFirst(master).split('\n').filter(Boolean),
    ).toEqual([
      '#EXTM3U',
      '#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=1,BANDWIDTH=2000',
      'high.m3u8',
      '#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=9000000,BANDWIDTH=1000',
      'low.m3u8',
    ]);
  });

  it('leaves single-variant, media and malformed playlists untouched', () => {
    const single =
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=750000\n0/stream.m3u8\n';
    const media = '#EXTM3U\n#EXTINF:2.0,\nsegment_000000.ts\n#EXT-X-ENDLIST\n';
    const missingBandwidth =
      '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1x1\na.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\nb.m3u8\n';

    expect(orderHlsMasterVariantsHighestFirst(single)).toBe(single);
    expect(orderHlsMasterVariantsHighestFirst(media)).toBe(media);
    expect(orderHlsMasterVariantsHighestFirst(missingBandwidth)).toBe(
      missingBandwidth,
    );
  });
});
