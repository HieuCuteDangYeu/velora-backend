import type { TranscriptionAudioFormat } from '@common/processing/interfaces/transcription-audio-manifest.interface';
import type {
  ReelEncodingProfile,
  TranscriptionAudioSegmentRequest,
} from '@processing/domain/interfaces/video-processing.service.interface';
import type { ReelPixelCrop } from '@common/processing/reel-media-crop';
import { formatReelPixelCropFilter } from '@common/processing/reel-media-crop';
import type { ReelMediaTrim } from '@common/processing/reel-media-trim';
import * as path from 'node:path';

const toKbps = (value: number): string => `${value}k`;

export function buildTemporalTrimArguments(trim?: ReelMediaTrim): string[] {
  if (!trim) return [];

  return [
    '-ss',
    (trim.sourceStartMs / 1000).toFixed(3),
    '-t',
    (trim.outputDurationMs / 1000).toFixed(3),
  ];
}

export function buildFfprobeArguments(inputPath: string): string[] {
  return [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    inputPath,
  ];
}

export function buildHlsTranscodeArguments(input: {
  inputPath: string;
  outputDir: string;
  profile: ReelEncodingProfile;
}): string[] {
  const { inputPath, outputDir, profile } = input;
  const variants = profile.variants;
  const gopSize = profile.outputFps * profile.segmentSeconds;
  const sourceFilter = profile.crop
    ? `[0:v:0]${formatReelPixelCropFilter(profile.crop)},split=${variants.length}${variants
        .map((_, index) => `[v${index}src]`)
        .join('')}`
    : `[0:v:0]split=${variants.length}${variants
        .map((_, index) => `[v${index}src]`)
        .join('')}`;
  const filterComplex = [
    sourceFilter,
    ...variants.map((variant, index) =>
      profile.crop
        ? `[v${index}src]scale=${variant.width}:${variant.height}:force_original_aspect_ratio=increase:force_divisible_by=2,crop=${variant.width}:${variant.height},setsar=1[v${index}]`
        : `[v${index}src]scale=${variant.width}:${variant.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${variant.width}:${variant.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v${index}]`,
    ),
  ].join(';');
  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i',
    inputPath,
    ...buildTemporalTrimArguments(profile.trim),
    '-filter_complex',
    filterComplex,
  ];

  variants.forEach((_, index) => {
    args.push('-map', `[v${index}]`);

    if (profile.hasAudio) {
      args.push('-map', '0:a:0');
    }
  });

  args.push(
    '-c:v',
    'libx264',
    '-preset',
    profile.x264Preset,
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(profile.outputFps),
    '-vsync',
    '1',
    '-g',
    String(gopSize),
    '-keyint_min',
    String(gopSize),
    '-sc_threshold',
    '0',
    '-force_key_frames',
    `expr:gte(t,n_forced*${profile.segmentSeconds})`,
  );

  variants.forEach((variant, index) => {
    args.push(
      `-profile:v:${index}`,
      'main',
      `-level:v:${index}`,
      '4.0',
      `-threads:v:${index}`,
      String(profile.threadsPerVariant),
      `-b:v:${index}`,
      toKbps(variant.bitrateKbps),
      `-maxrate:v:${index}`,
      toKbps(variant.maxrateKbps),
      `-bufsize:v:${index}`,
      toKbps(variant.bufsizeKbps),
    );
  });

  if (profile.hasAudio) {
    args.push('-c:a', 'aac', '-ar', '48000');

    variants.forEach((variant, index) => {
      args.push(`-b:a:${index}`, toKbps(variant.audioBitrateKbps));
    });
  }

  args.push(
    '-start_number',
    '0',
    '-hls_time',
    String(profile.segmentSeconds),
    '-hls_playlist_type',
    'vod',
    '-hls_segment_type',
    'mpegts',
    '-hls_flags',
    'independent_segments',
    '-hls_list_size',
    '0',
    '-hls_segment_filename',
    path.join(outputDir, '%v', 'segment_%06d.ts'),
    '-master_pl_name',
    'master.m3u8',
    '-var_stream_map',
    variants
      .map((_, index) =>
        profile.hasAudio ? `v:${index},a:${index}` : `v:${index}`,
      )
      .join(' '),
    '-f',
    'hls',
    path.join(outputDir, '%v', 'stream.m3u8'),
  );

  return args;
}

export function buildThumbnailArguments(input: {
  inputPath: string;
  outputPath: string;
  timestampSeconds: number;
  crop?: ReelPixelCrop;
  trim?: ReelMediaTrim;
}): string[] {
  const videoFilter = input.crop
    ? `${formatReelPixelCropFilter(input.crop)},scale=480:480:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`
    : 'scale=480:480:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1';

  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-ss',
    (input.timestampSeconds + (input.trim?.sourceStartMs ?? 0) / 1000).toFixed(
      3,
    ),
    '-i',
    input.inputPath,
    '-frames:v',
    '1',
    '-vf',
    videoFilter,
    '-q:v',
    '3',
    input.outputPath,
  ];
}

export function buildTranscriptionAudioArguments(input: {
  inputPath: string;
  segment: TranscriptionAudioSegmentRequest;
  format: TranscriptionAudioFormat;
}): string[] {
  const durationSeconds = Math.max(
    0.001,
    (input.segment.endMs - input.segment.startMs) / 1000,
  );

  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-ss',
    (input.segment.startMs / 1000).toFixed(3),
    '-t',
    durationSeconds.toFixed(3),
    '-i',
    input.inputPath,
    '-map',
    '0:a:0',
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-af',
    'highpass=f=80,lowpass=f=8000,loudnorm',
    '-c:a',
    input.format === 'flac' ? 'flac' : 'pcm_s16le',
    '-f',
    input.format,
    input.segment.outputPath,
  ];
}
