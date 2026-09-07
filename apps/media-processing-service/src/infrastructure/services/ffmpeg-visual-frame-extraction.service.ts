import type {
  ExtractedVisualFrame,
  IVisualFrameExtractionService,
} from '@processing/domain/interfaces/visual-frame-extraction.service.interface';
import type { ReelPixelCrop } from '@common/processing/reel-media-crop';
import { formatReelPixelCropFilter } from '@common/processing/reel-media-crop';
import type { ReelMediaTrim } from '@common/processing/reel-media-trim';
import { buildTemporalTrimArguments } from './ffmpeg-arguments';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface ProcessResult {
  stderr: string;
}

export function buildVisualFrameFilter(input: {
  mode: 'periodic' | 'scene';
  intervalSeconds?: number;
  sceneThreshold?: number;
  crop?: ReelPixelCrop;
  trim?: ReelMediaTrim;
}): string {
  const cropFilter = input.crop
    ? `${formatReelPixelCropFilter(input.crop)},`
    : '';

  if (input.mode === 'periodic') {
    return `${cropFilter}fps=1/${input.intervalSeconds}:start_time=0,scale='min(1280,iw)':-2`;
  }

  return `${cropFilter}select='gt(scene,${input.sceneThreshold})',showinfo,scale='min(1280,iw)':-2`;
}

@Injectable()
export class FfmpegVisualFrameExtractionService implements IVisualFrameExtractionService {
  private readonly ffmpegPath: string;

  constructor(private readonly configService: ConfigService) {
    this.ffmpegPath = this.resolveBinaryPath();
  }

  async extractCandidateFrames(input: {
    inputPath: string;
    outputDir: string;
    totalDurationMs: number;
    periodicIntervalMs: number;
    sceneThreshold: number;
    crop?: ReelPixelCrop;
    trim?: ReelMediaTrim;
  }): Promise<ExtractedVisualFrame[]> {
    const periodicDir = path.join(input.outputDir, 'periodic');
    const sceneDir = path.join(input.outputDir, 'scene');
    fs.mkdirSync(periodicDir, { recursive: true });
    fs.mkdirSync(sceneDir, { recursive: true });

    const [periodic, scene] = await Promise.all([
      this.extractPeriodic({ ...input, outputDir: periodicDir }),
      this.extractSceneChanges({ ...input, outputDir: sceneDir }),
    ]);

    return [...periodic, ...scene].sort(
      (left, right) => left.timestampMs - right.timestampMs,
    );
  }

  private async extractPeriodic(input: {
    inputPath: string;
    outputDir: string;
    totalDurationMs: number;
    periodicIntervalMs: number;
    crop?: ReelPixelCrop;
    trim?: ReelMediaTrim;
  }): Promise<ExtractedVisualFrame[]> {
    const intervalSeconds = Math.max(0.25, input.periodicIntervalMs / 1000);
    const pattern = path.join(input.outputDir, 'periodic_%06d.jpg');
    await this.run([
      '-hide_banner',
      '-loglevel',
      'warning',
      '-i',
      input.inputPath,
      ...buildTemporalTrimArguments(input.trim),
      '-vf',
      buildVisualFrameFilter({
        mode: 'periodic',
        intervalSeconds,
        crop: input.crop,
      }),
      '-q:v',
      '3',
      '-an',
      '-y',
      pattern,
    ]);

    return this.listJpegs(input.outputDir).map((outputPath, index) => ({
      outputPath,
      timestampMs: Math.min(
        Math.max(0, input.totalDurationMs - 1),
        Math.round(index * input.periodicIntervalMs),
      ),
      reason: 'PERIODIC' as const,
    }));
  }

  private async extractSceneChanges(input: {
    inputPath: string;
    outputDir: string;
    totalDurationMs: number;
    sceneThreshold: number;
    crop?: ReelPixelCrop;
    trim?: ReelMediaTrim;
  }): Promise<ExtractedVisualFrame[]> {
    const pattern = path.join(input.outputDir, 'scene_%06d.jpg');
    const result = await this.run([
      '-hide_banner',
      '-loglevel',
      'info',
      '-i',
      input.inputPath,
      ...buildTemporalTrimArguments(input.trim),
      '-vf',
      buildVisualFrameFilter({
        mode: 'scene',
        sceneThreshold: input.sceneThreshold,
        crop: input.crop,
      }),
      '-vsync',
      'vfr',
      '-q:v',
      '3',
      '-an',
      '-y',
      pattern,
    ]);
    const timestamps = this.parseShowInfoTimestamps(result.stderr);

    return this.listJpegs(input.outputDir).map((outputPath, index) => ({
      outputPath,
      timestampMs: Math.min(
        Math.max(0, input.totalDurationMs - 1),
        Math.max(0, Math.round((timestamps[index] ?? 0) * 1000)),
      ),
      reason: 'SCENE_CHANGE' as const,
    }));
  }

  private parseShowInfoTimestamps(stderr: string): number[] {
    const values: number[] = [];
    for (const line of stderr.split(/\r?\n/)) {
      if (!line.includes('showinfo')) continue;
      const match = line.match(/\bpts_time:([+-]?(?:\d+(?:\.\d+)?|\.\d+))/);
      if (!match) continue;
      const value = Number(match[1]);
      if (Number.isFinite(value) && value >= 0) values.push(value);
    }
    return values;
  }

  private listJpegs(directory: string): string[] {
    return fs
      .readdirSync(directory)
      .filter((name) => name.toLowerCase().endsWith('.jpg'))
      .sort()
      .map((name) => path.join(directory, name));
  }

  private run(args: string[]): Promise<ProcessResult> {
    const timeoutMs = this.getPositiveInt(
      'MEDIA_VISUAL_FRAME_EXTRACTION_TIMEOUT_MS',
      180_000,
      5_000,
      900_000,
    );

    return new Promise((resolve, reject) => {
      const child = spawn(this.ffmpegPath, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
      let stderr = '';
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);
      timeout.unref();

      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
        if (stderr.length > 2_000_000) {
          stderr = stderr.slice(-2_000_000);
        }
      });

      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      child.once('close', (code) => {
        clearTimeout(timeout);
        if (code === 0 && !timedOut) {
          resolve({ stderr });
          return;
        }
        reject(
          new Error(
            `ffmpeg visual frame extraction ${timedOut ? 'timed out' : `failed with code ${String(code)}`}: ${stderr.slice(-4_000)}`,
          ),
        );
      });
    });
  }

  private resolveBinaryPath(): string {
    const configured = this.configService.get<string>('FFMPEG_PATH')?.trim();
    if (configured && this.canExecute(configured)) return configured;

    const executableName =
      process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
      const candidate = path.join(directory, executableName);
      if (this.canExecute(candidate)) return candidate;
    }

    throw new Error(
      'ffmpeg is not executable. Set FFMPEG_PATH or install it in the runtime image.',
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
    const value = Number(this.configService.get<string>(key) ?? fallback);
    return Number.isFinite(value)
      ? Math.min(max, Math.max(min, Math.round(value)))
      : fallback;
  }
}
