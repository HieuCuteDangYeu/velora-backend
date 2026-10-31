import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReelHlsReplacementPlan } from '@common/content/reel-hls-replacement';
import { ReelHlsArtifactValidatorService } from './reel-hls-artifact-validator.service';

function fixture() {
  const objects = new Map([
    [
      'master.m3u8',
      Buffer.from(
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=750000\n0/stream.m3u8\n',
      ),
    ],
    [
      '0/stream.m3u8',
      Buffer.from(
        '#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXTINF:2,\nsegment_000000.ts\n#EXT-X-ENDLIST\n',
      ),
    ],
    ['0/segment_000000.ts', Buffer.from('transport-stream')],
    ['thumbnail.jpg', Buffer.from('thumbnail')],
  ]);
  const plan = {
    reelId: 'reel',
    attemptId: 'attempt',
    variants: [{}],
    outputDurationMs: 2000,
    outputFps: 25,
    segmentSeconds: 2,
    files: [...objects].map(([path, data]) => ({
      path,
      bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    })),
  } as ReelHlsReplacementPlan;
  const send = jest.fn(({ input }: { input: { Key: string } }) => {
    const data = objects.get(input.Key.replace('reels/reel/attempt/', ''));
    if (!data) throw new Error('missing object');
    return Promise.resolve({
      ContentLength: data.length,
      Body: Readable.from([data]),
    });
  });
  const validator = Object.create(
    ReelHlsArtifactValidatorService.prototype,
  ) as ReelHlsArtifactValidatorService;
  Object.assign(validator, {
    client: { send },
    config: { get: () => 'bucket' },
  });
  return { objects, plan, send, validator };
}

describe('staged HLS artifact validation', () => {
  it('reads and hashes every reviewed segment and playlist before accepting the complete graph', async () => {
    const f = fixture();
    await expect(f.validator.validate(f.plan)).resolves.toBeUndefined();
    expect(f.send).toHaveBeenCalledTimes(4);
  });
  it.each(['missing', 'checksum', 'partial'])(
    'rejects a %s object',
    async (failure) => {
      const f = fixture();
      if (failure === 'missing') f.objects.delete('0/segment_000000.ts');
      if (failure === 'checksum')
        f.objects.set('0/segment_000000.ts', Buffer.from('different-stream'));
      if (failure === 'partial')
        f.send.mockImplementationOnce(() =>
          Promise.resolve({
            ContentLength: f.plan.files[0].bytes,
            Body: Readable.from([Buffer.from('short')]),
          }),
        );
      await expect(f.validator.validate(f.plan)).rejects.toThrow();
    },
  );
});
