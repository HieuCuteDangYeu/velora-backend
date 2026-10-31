import {
  validateHlsArtifactGraph,
  type ReelHlsReplacementPlan,
} from './reel-hls-replacement';

function artifact() {
  const playlists = new Map([
    [
      'master.m3u8',
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=750000\n0/stream.m3u8\n',
    ],
    [
      '0/stream.m3u8',
      '#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXTINF:2,\nsegment_000000.ts\n#EXT-X-ENDLIST\n',
    ],
  ]);
  const plan = {
    variants: [{}],
    outputDurationMs: 2000,
    outputFps: 25,
    segmentSeconds: 2,
    files: [
      'master.m3u8',
      '0/stream.m3u8',
      '0/segment_000000.ts',
      'thumbnail.jpg',
    ].map((path) => ({ path })),
  } as ReelHlsReplacementPlan;
  return { plan, playlists };
}

describe('reviewed replacement HLS graph', () => {
  it('accepts a complete local VOD graph', () => {
    const f = artifact();
    expect(() => validateHlsArtifactGraph(f.plan, f.playlists)).not.toThrow();
  });
  it.each([
    'missing',
    'partial',
    'remote',
    'escape',
    'duration',
    'duplicate',
    'orphan',
    'rendition',
    'thumbnail',
  ])('rejects %s output', (failure) => {
    const f = artifact();
    const text = f.playlists.get('0/stream.m3u8')!;
    if (failure === 'missing') f.plan.files.splice(2, 1);
    if (failure === 'thumbnail')
      f.plan.files = f.plan.files.filter(
        (file) => file.path !== 'thumbnail.jpg',
      );
    if (failure === 'partial')
      f.playlists.set('0/stream.m3u8', text.replace('#EXT-X-ENDLIST', ''));
    if (failure === 'remote')
      f.playlists.set(
        '0/stream.m3u8',
        text.replace('segment_000000.ts', 'https://cdn.example/segment.ts'),
      );
    if (failure === 'escape')
      f.playlists.set(
        '0/stream.m3u8',
        text.replace('segment_000000.ts', '../../segment.ts'),
      );
    if (failure === 'duration')
      f.playlists.set('0/stream.m3u8', text.replace('EXTINF:2', 'EXTINF:5'));
    if (failure === 'duplicate') f.plan.files.push(f.plan.files[0]);
    if (failure === 'orphan')
      f.plan.files.push({ ...f.plan.files[2], path: '0/segment_000001.ts' });
    if (failure === 'rendition') f.plan.variants.push(f.plan.variants[0]);
    expect(() => validateHlsArtifactGraph(f.plan, f.playlists)).toThrow();
  });
});
