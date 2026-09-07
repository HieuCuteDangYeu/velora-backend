import type { ReelEncodingProfile } from '@processing/domain/interfaces/video-processing.service.interface';
import {
  buildHlsTranscodeArguments,
  buildThumbnailArguments,
} from './ffmpeg-arguments';

const variant = {
  name: '360p' as const,
  width: 360,
  height: 640,
  bitrateKbps: 750,
  maxrateKbps: 950,
  bufsizeKbps: 1500,
  audioBitrateKbps: 96,
};

const baseProfile = {
  profileName: 'balanced' as const,
  outputFps: 30,
  segmentSeconds: 2,
  x264Preset: 'faster',
  threadsPerVariant: 2,
  timeoutMs: 120_000,
  hasAudio: true,
  variants: [variant],
} satisfies ReelEncodingProfile;

const crop = { x: 320, y: 0, width: 608, height: 1080 };

describe('FFmpeg reel arguments', () => {
  it('keeps the legacy fit filter graph and audio mapping', () => {
    const args = buildHlsTranscodeArguments({
      inputPath: '/tmp/source.mp4',
      outputDir: '/tmp/hls',
      profile: baseProfile,
    });
    const filter = args[args.indexOf('-filter_complex') + 1];

    expect(filter).toBe(
      '[0:v:0]split=1[v0src];[v0src]scale=360:640:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=360:640:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v0]',
    );
    expect(filter).not.toContain('crop=');
    expect(args.filter((value) => value === '0:a:0')).toHaveLength(1);
  });

  it('crops once before split, selects portrait scaling, and keeps audio mapping', () => {
    const args = buildHlsTranscodeArguments({
      inputPath: '/tmp/source.mp4',
      outputDir: '/tmp/hls',
      profile: { ...baseProfile, crop },
    });
    const filter = args[args.indexOf('-filter_complex') + 1];

    expect(filter).toContain('[0:v:0]crop=608:1080:320:0,split=1[v0src]');
    expect(filter).toContain(
      'scale=360:640:force_original_aspect_ratio=increase:force_divisible_by=2,crop=360:640,setsar=1',
    );
    expect(filter).not.toContain('pad=');
    expect(args.filter((value) => value === '0:a:0')).toHaveLength(1);
  });

  it('adds the same crop rectangle to thumbnail extraction only in crop mode', () => {
    const fitArgs = buildThumbnailArguments({
      inputPath: '/tmp/source.mp4',
      outputPath: '/tmp/thumbnail.jpg',
      timestampSeconds: 2,
    });
    const cropArgs = buildThumbnailArguments({
      inputPath: '/tmp/source.mp4',
      outputPath: '/tmp/thumbnail.jpg',
      timestampSeconds: 2,
      crop,
    });

    expect(fitArgs[fitArgs.indexOf('-vf') + 1]).toBe(
      'scale=480:480:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1',
    );
    expect(cropArgs[cropArgs.indexOf('-vf') + 1]).toBe(
      'crop=608:1080:320:0,scale=480:480:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1',
    );
  });

  it('applies trim before the HLS filter graph and offsets thumbnail seek', () => {
    const trim = {
      sourceStartMs: 2500,
      sourceEndMs: 6500,
      outputDurationMs: 4000,
    };
    const hlsArgs = buildHlsTranscodeArguments({
      inputPath: '/tmp/source.mp4',
      outputDir: '/tmp/hls',
      profile: { ...baseProfile, trim },
    });
    const thumbnailArgs = buildThumbnailArguments({
      inputPath: '/tmp/source.mp4',
      outputPath: '/tmp/thumbnail.jpg',
      timestampSeconds: 1,
      trim,
    });

    expect(
      hlsArgs.slice(hlsArgs.indexOf('-i'), hlsArgs.indexOf('-filter_complex')),
    ).toEqual(['-i', '/tmp/source.mp4', '-ss', '2.500', '-t', '4.000']);
    expect(thumbnailArgs.slice(0, thumbnailArgs.indexOf('-i'))).toContain(
      '3.500',
    );
  });
});
