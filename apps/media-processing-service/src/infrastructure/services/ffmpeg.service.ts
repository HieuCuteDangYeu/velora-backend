import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  IVideoProcessingService,
  ReelEncodingProfile,
  TranscodeToHlsResult,
  TranscriptionAudioSegmentRequest,
  TranscriptionAudioSegmentResult,
  VideoMetadata,
  VideoProcessExecutionOptions,
} from '@processing/domain/interfaces/video-processing.service.interface';
import type { TranscriptionAudioFormat } from '@common/processing/interfaces/transcription-audio-manifest.interface';
import type { ReelPixelCrop } from '@common/processing/reel-media-crop';
import type { ReelMediaTrim } from '@common/processing/reel-media-trim';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildFfprobeArguments,
  buildHlsTranscodeArguments,
  buildThumbnailArguments,
  buildTranscriptionAudioArguments,
} from './ffmpeg-arguments';

interface ProcessResult {
  stdout: string;
  stderr: string;
}

interface ProcessRunOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  maxStdoutBytes?: number;
}

export class MediaProcessError extends Error {
  constructor(
    message: string,
    readonly command: 'ffmpeg' | 'ffprobe',
    readonly exitCode: number | null,
    readonly exitSignal: NodeJS.Signals | null,
    readonly stderr: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'MediaProcessError';
  }
}

const parsePositiveNumber = (value: unknown): number | undefined => {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : Number.NaN;

  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const parseFrameRate = (value: unknown): number | undefined => {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return undefined;
  }

  const raw = String(value);

  if (!raw.includes('/')) {
    const parsed = parsePositiveNumber(raw);
    return parsed ? Number(parsed.toFixed(3)) : undefined;
  }

  const [numeratorRaw, denominatorRaw] = raw.split('/');
  const numerator = Number(numeratorRaw);
  const denominator = Number(denominatorRaw);

  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    return undefined;
  }

  if (numerator <= 0 || denominator <= 0) {
    return undefined;
  }

  return Number((numerator / denominator).toFixed(3));
};

const normalizeRotation = (value: unknown): number | undefined => {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return ((Math.round(parsed) % 360) + 360) % 360;
};

@Injectable()
export class FfmpegService implements IVideoProcessingService, OnModuleDestroy {
  private readonly logger = new Logger(FfmpegService.name);
  private readonly activeProcesses = new Set<ChildProcess>();
  private readonly ffmpegPath: string;
  private readonly ffprobePath: string;
  private readonly maxStderrBytes: number;
  private shuttingDown = false;

  constructor(private readonly configService: ConfigService) {
    this.ffmpegPath = this.resolveBinaryPath('ffmpeg', 'FFMPEG_PATH');
    this.ffprobePath = this.resolveBinaryPath('ffprobe', 'FFPROBE_PATH');
    this.maxStderrBytes = this.getPositiveInt(
      'MEDIA_PROCESS_STDERR_MAX_BYTES',
      65_536,
      4096,
      1_048_576,
    );
  }

  onModuleDestroy(): void {
    this.shuttingDown = true;
    for (const process of this.activeProcesses) {
      this.terminateProcess(process);
    }
  }

  async getVideoMetadata(
    inputPath: string,
    options: VideoProcessExecutionOptions = {},
  ): Promise<VideoMetadata> {
    const result = await this.runProcess(
      'ffprobe',
      this.ffprobePath,
      buildFfprobeArguments(inputPath),
      {
        signal: options.signal,
        timeoutMs:
          options.timeoutMs ??
          this.getPositiveInt(
            'MEDIA_FFPROBE_TIMEOUT_MS',
            60_000,
            1000,
            600_000,
          ),
        maxStdoutBytes: 2_097_152,
      },
    );

    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    const streams = Array.isArray(parsed['streams'])
      ? (parsed['streams'] as Array<Record<string, unknown>>)
      : [];
    const format =
      typeof parsed['format'] === 'object' && parsed['format'] !== null
        ? (parsed['format'] as Record<string, unknown>)
        : {};
    const video = streams.find((stream) => stream['codec_type'] === 'video');
    const audio = streams.find((stream) => stream['codec_type'] === 'audio');

    if (!video) {
      throw new MediaProcessError(
        'ffprobe did not report a video stream',
        'ffprobe',
        0,
        null,
        result.stderr,
      );
    }

    const tags =
      typeof video['tags'] === 'object' && video['tags'] !== null
        ? (video['tags'] as Record<string, unknown>)
        : {};
    const sideData = Array.isArray(video['side_data_list'])
      ? (video['side_data_list'] as Array<Record<string, unknown>>)
      : [];
    const sideDataRotation = sideData
      .map((item) => normalizeRotation(item['rotation']))
      .find((rotation) => rotation !== undefined);
    const averageFps = parseFrameRate(video['avg_frame_rate']);
    const nominalFps = parseFrameRate(video['r_frame_rate']);
    const durationSeconds =
      parsePositiveNumber(format['duration']) ??
      parsePositiveNumber(video['duration']);
    const bitrateBitsPerSecond =
      parsePositiveNumber(video['bit_rate']) ??
      parsePositiveNumber(format['bit_rate']);

    return {
      durationMs: durationSeconds
        ? Math.max(0, Math.round(durationSeconds * 1000))
        : undefined,
      width: parsePositiveNumber(video['width']),
      height: parsePositiveNumber(video['height']),
      fps: averageFps ?? nominalFps,
      bitrateKbps: bitrateBitsPerSecond
        ? Math.round(bitrateBitsPerSecond / 1000)
        : undefined,
      hasAudio: Boolean(audio),
      rotation:
        sideDataRotation ??
        normalizeRotation(video['rotation']) ??
        normalizeRotation(tags['rotate']),
      codecName:
        typeof video['codec_name'] === 'string'
          ? video['codec_name']
          : undefined,
      pixelFormat:
        typeof video['pix_fmt'] === 'string' ? video['pix_fmt'] : undefined,
      audioCodecName:
        typeof audio?.['codec_name'] === 'string'
          ? audio['codec_name']
          : undefined,
      fileSizeBytes: parsePositiveNumber(format['size']),
      isVariableFrameRate:
        averageFps !== undefined && nominalFps !== undefined
          ? Math.abs(averageFps - nominalFps) > 0.01
          : undefined,
    };
  }

  async transcodeToHls(
    inputPath: string,
    outputDir: string,
    profile: ReelEncodingProfile,
    options: VideoProcessExecutionOptions = {},
  ): Promise<TranscodeToHlsResult> {
    fs.mkdirSync(outputDir, { recursive: true });

    profile.variants.forEach((_, index) => {
      fs.mkdirSync(path.join(outputDir, String(index)), { recursive: true });
    });

    this.logger.log(
      `[HLS] profile=${profile.profileName}, fps=${profile.outputFps}, segment=${profile.segmentSeconds}s, variants=${profile.variants
        .map((variant) => `${variant.name}:${variant.width}x${variant.height}`)
        .join(',')}`,
    );

    await this.runProcess(
      'ffmpeg',
      this.ffmpegPath,
      buildHlsTranscodeArguments({ inputPath, outputDir, profile }),
      {
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? profile.timeoutMs,
      },
    );

    return {
      variantCount: profile.variants.length,
      maxHeight: Math.max(...profile.variants.map((variant) => variant.height)),
      outputFps: profile.outputFps,
      segmentSeconds: profile.segmentSeconds,
      variantNames: profile.variants.map((variant) => variant.name),
      variants: profile.variants.map(({ name, width, height }) => ({
        name,
        width,
        height,
      })),
    };
  }

  async extractTranscriptionAudioSegments(
    inputPath: string,
    segments: TranscriptionAudioSegmentRequest[],
    format: TranscriptionAudioFormat,
    options: VideoProcessExecutionOptions = {},
  ): Promise<TranscriptionAudioSegmentResult[]> {
    const results: TranscriptionAudioSegmentResult[] = [];

    for (const segment of segments) {
      fs.mkdirSync(path.dirname(segment.outputPath), { recursive: true });
      const segmentDurationMs = segment.endMs - segment.startMs;
      const timeoutMs =
        options.timeoutMs ??
        Math.max(
          120_000,
          Math.round(
            segmentDurationMs *
              this.getPositiveNumber(
                'MEDIA_AUDIO_TIMEOUT_DURATION_MULTIPLIER',
                4,
                1,
                20,
              ),
          ),
        );

      await this.runProcess(
        'ffmpeg',
        this.ffmpegPath,
        buildTranscriptionAudioArguments({ inputPath, segment, format }),
        {
          signal: options.signal,
          timeoutMs,
        },
      );

      results.push({
        ...segment,
        byteLength: fs.statSync(segment.outputPath).size,
      });
    }

    return results;
  }

  async extractThumbnail(
    inputPath: string,
    outputPath: string,
    timestampSeconds = 2,
    options: VideoProcessExecutionOptions & {
      crop?: ReelPixelCrop;
      trim?: ReelMediaTrim;
    } = {},
  ): Promise<void> {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    await this.runProcess(
      'ffmpeg',
      this.ffmpegPath,
      buildThumbnailArguments({
        inputPath,
        outputPath,
        timestampSeconds: Math.max(0, timestampSeconds),
        crop: options.crop,
        trim: options.trim,
      }),
      {
        signal: options.signal,
        timeoutMs:
          options.timeoutMs ??
          this.getPositiveInt(
            'MEDIA_THUMBNAIL_TIMEOUT_MS',
            120_000,
            1000,
            600_000,
          ),
      },
    );
  }

  private async runProcess(
    commandName: 'ffmpeg' | 'ffprobe',
    commandPath: string,
    args: string[],
    options: ProcessRunOptions,
  ): Promise<ProcessResult> {
    return await new Promise((resolve, reject) => {
      const child = spawn(commandPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout: Buffer = Buffer.alloc(0);
      let stderr: Buffer = Buffer.alloc(0);
      let timedOut = false;
      let aborted = false;
      let settled = false;
      const maxStdoutBytes = options.maxStdoutBytes ?? 16_384;

      this.activeProcesses.add(child);

      const onAbort = () => {
        aborted = true;
        this.terminateProcess(child);
      };

      options.signal?.addEventListener('abort', onAbort, { once: true });

      if (options.signal?.aborted) {
        onAbort();
      }

      const timeout = setTimeout(() => {
        timedOut = true;
        this.terminateProcess(child);
      }, options.timeoutMs);
      timeout.unref();

      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout = this.appendBounded(stdout, chunk, maxStdoutBytes);
      });

      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr = this.appendBounded(stderr, chunk, this.maxStderrBytes);
      });

      const cleanup = () => {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', onAbort);
        this.activeProcesses.delete(child);
      };

      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          new MediaProcessError(
            `${commandName} could not start: ${error.message}`,
            commandName,
            null,
            null,
            stderr.toString('utf8'),
          ),
        );
      });

      child.once('close', (exitCode, exitSignal) => {
        if (settled) return;
        settled = true;
        cleanup();
        const stderrText = stderr.toString('utf8');

        if (exitCode === 0 && !timedOut && !aborted) {
          resolve({
            stdout: stdout.toString('utf8'),
            stderr: stderrText,
          });
          return;
        }

        const interruptedByShutdown = this.shuttingDown;
        const reason = timedOut
          ? `timed out after ${options.timeoutMs}ms`
          : aborted
            ? 'was cancelled'
            : interruptedByShutdown
              ? 'was interrupted by service shutdown'
              : `exited with code ${String(exitCode)} and signal ${String(exitSignal)}`;

        reject(
          new MediaProcessError(
            `${commandName} ${reason}`,
            commandName,
            exitCode,
            exitSignal,
            stderrText,
            interruptedByShutdown,
          ),
        );
      });
    });
  }

  private terminateProcess(child: ChildProcess): void {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    child.kill('SIGTERM');
    const forceKill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }, 2000);
    forceKill.unref();
  }

  private appendBounded(
    existing: Buffer,
    chunk: Buffer | string,
    maxBytes: number,
  ): Buffer {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');

    if (next.length >= maxBytes) {
      return next.subarray(next.length - maxBytes);
    }

    const keepExistingBytes = Math.max(0, maxBytes - next.length);
    const boundedExisting =
      existing.length > keepExistingBytes
        ? existing.subarray(existing.length - keepExistingBytes)
        : existing;

    return Buffer.concat([boundedExisting, next]);
  }

  private resolveBinaryPath(
    binaryName: 'ffmpeg' | 'ffprobe',
    envKey: 'FFMPEG_PATH' | 'FFPROBE_PATH',
  ): string {
    const configured = this.configService.get<string>(envKey)?.trim();

    if (configured && this.canExecute(configured)) {
      return configured;
    }

    const pathValue = process.env.PATH;

    if (pathValue) {
      const executableName =
        process.platform === 'win32' ? `${binaryName}.exe` : binaryName;

      for (const directory of pathValue.split(path.delimiter)) {
        const candidate = path.join(directory, executableName);

        if (this.canExecute(candidate)) {
          return candidate;
        }
      }
    }

    throw new Error(
      `${binaryName} is not executable. Set ${envKey} or install the pinned binary in the runtime image.`,
    );
  }

  private canExecute(candidate: string): boolean {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  private getPositiveInt(
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    return Math.round(this.getPositiveNumber(key, fallback, min, max));
  }

  private getPositiveNumber(
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const parsed = Number(this.configService.get<string>(key) ?? fallback);

    if (!Number.isFinite(parsed)) {
      return fallback;
    }

    return Math.min(max, Math.max(min, parsed));
  }
}
