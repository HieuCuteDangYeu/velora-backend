import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  HlsStreamingUpload,
  ITikTokCdnService,
  TikTokCdnImageResult,
  TikTokCdnPingResult,
  TikTokCdnProcessOptions,
  TikTokCdnUploadResult,
} from '../../domain/interfaces/tiktok-cdn.service.interface';

// 1x1 PNG header (67 bytes) used as image prefix mask.
const PNG_HEX =
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082';
const PNG_MASK = Buffer.from(PNG_HEX, 'hex');
const PNG_MASK_SIZE = 67;

// A stalled CDN request used to wait for Node's own 5 minute default, and the worker takes one job
// at a time, so one stall froze the whole lane. A reel's segments must upload within the budget or
// the caller falls back to R2, which is far quicker than waiting.
// A healthy upload answers in 0.3-0.5 s, so 10 s is a stall. A stalled request is cut and tried again
// on a fresh connection (stalls were intermittent, one in three 96 s reels, mostly on the first
// segments), and only repeated failures send the reel to R2.
const DEFAULT_CDN_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_CDN_UPLOAD_BUDGET_MS = 120_000;
const CDN_UPLOAD_CONCURRENCY = 3;
// All jobs of one worker share this many CDN uploads at a time. One job uses at most
// CDN_UPLOAD_CONCURRENCY, so a single job is unaffected; it only matters when a worker runs
// several jobs (MEDIA_VIDEO_PROCESSING_CONCURRENCY > 1) on the one TikTok session.
const DEFAULT_CDN_MAX_PARALLEL_UPLOADS = 4;
const CDN_STREAMING_POLL_MS = 300;
const DEFAULT_CDN_UPLOAD_RETRIES = 2;
const CDN_RETRY_BACKOFF_MS = 300;
const CDN_PING_TIMEOUT_MS = 15_000;

interface SegmentUploadResult {
  filename: string;
  localPath: string;
  remoteUrl: string;
  originalSize: number;
}

interface TikTokUploadApiResponse {
  code?: number;
  msg?: string;
  data?: {
    url?: string;
    image_info?: {
      size?: number;
      width?: number;
      height?: number;
    };
  };
}

/** A failure of the connection or of TikTok itself that is worth another attempt. */
class CdnTransportError extends Error {}

@Injectable()
export class TikTokCdnService implements ITikTokCdnService {
  private readonly logger = new Logger(TikTokCdnService.name);
  private readonly uploadEndpoint: string;
  private readonly csrfToken: string;
  private readonly uuid: string;
  private readonly cookie: string;
  private readonly defaultSegmentDuration: number;
  private readonly ffmpegPath: string;
  private readonly requestTimeoutMs: number;
  private readonly uploadBudgetMs: number;
  private readonly uploadRetries: number;
  // Upload slots shared by every job in this process (see TIKTOK_CDN_MAX_PARALLEL_UPLOADS).
  private readonly maxParallelUploads: number;
  private activeUploads = 0;
  private readonly uploadWaiters: Array<() => void> = [];

  constructor(private readonly configService: ConfigService) {
    this.uploadEndpoint =
      this.configService.get<string>('TIKTOK_CDN_UPLOAD_ENDPOINT') ||
      this.configService.get<string>('CDN_UPLOAD_ENDPOINT') ||
      '';
    this.csrfToken =
      this.configService.get<string>('TIKTOK_CDN_CSRF_TOKEN') ||
      this.configService.get<string>('CDN_CSRF_TOKEN') ||
      '';
    this.uuid =
      this.configService.get<string>('TIKTOK_CDN_UUID') ||
      this.configService.get<string>('CDN_UUID') ||
      '';
    this.cookie =
      this.configService.get<string>('TIKTOK_CDN_COOKIE') ||
      this.configService.get<string>('CDN_COOKIE') ||
      '';
    this.defaultSegmentDuration = Number(
      this.configService.get<string>('TIKTOK_HLS_SEGMENT_DURATION') ||
        this.configService.get<string>('HLS_SEGMENT_DURATION') ||
        '5',
    );
    this.ffmpegPath = this.configService.get<string>('FFMPEG_PATH') || 'ffmpeg';
    this.requestTimeoutMs = this.positiveMs(
      'TIKTOK_CDN_REQUEST_TIMEOUT_MS',
      DEFAULT_CDN_REQUEST_TIMEOUT_MS,
    );
    this.uploadBudgetMs = this.positiveMs(
      'TIKTOK_CDN_UPLOAD_BUDGET_MS',
      DEFAULT_CDN_UPLOAD_BUDGET_MS,
    );
    const retries = Number(
      this.configService.get<string>('TIKTOK_CDN_UPLOAD_RETRIES'),
    );
    this.maxParallelUploads = Math.max(
      1,
      Math.floor(
        Number(
          this.configService.get<string>('TIKTOK_CDN_MAX_PARALLEL_UPLOADS'),
        ) || DEFAULT_CDN_MAX_PARALLEL_UPLOADS,
      ),
    );
    this.uploadRetries =
      Number.isInteger(retries) && retries >= 0 && retries <= 5
        ? retries
        : DEFAULT_CDN_UPLOAD_RETRIES;
  }

  private positiveMs(key: string, fallback: number): number {
    const value = Number(this.configService.get<string>(key));
    return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
  }

  validateConfig(): boolean {
    return Boolean(
      this.uploadEndpoint && this.csrfToken && this.uuid && this.cookie,
    );
  }

  // Pings TikTok Ads API to keep session cookies alive and verify health.
  async pingSession(): Promise<TikTokCdnPingResult> {
    if (!this.validateConfig()) {
      return {
        isAlive: false,
        message: 'TikTok CDN credentials are not configured.',
      };
    }

    try {
      const urlObj = new URL(this.uploadEndpoint);
      const pingUrl = `${urlObj.protocol}//${urlObj.host}/api/v2/i18n/advertiser/info/`;

      const response = await fetch(pingUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(CDN_PING_TIMEOUT_MS),
        headers: {
          'x-ttam-uuid': this.uuid,
          'x-csrftoken': this.csrfToken,
          Cookie: this.cookie,
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      });

      const bodyText = await response.text();
      let parsed: { code?: number; msg?: string } = {};
      try {
        parsed = JSON.parse(bodyText) as { code?: number; msg?: string };
      } catch {
        return {
          isAlive: false,
          statusCode: response.status,
          message: `Failed to parse response: ${bodyText.slice(0, 100)}`,
        };
      }

      if (parsed.code === 0) {
        return {
          isAlive: true,
          statusCode: response.status,
          message: 'Session active',
        };
      }

      return {
        isAlive: false,
        statusCode: response.status,
        message: parsed.msg || `TikTok error code ${parsed.code}`,
      };
    } catch (err) {
      return {
        isAlive: false,
        message: `Network error: ${String(err)}`,
      };
    }
  }

  // Slices video into HLS .ts segments and uploads them to TikTok CDN masked as PNG.
  async processAndUploadVideoHls(
    inputPath: string,
    outputDir: string,
    options: TikTokCdnProcessOptions = {},
  ): Promise<TikTokCdnUploadResult> {
    if (!this.validateConfig()) {
      throw new Error('TikTok CDN credentials are not properly configured.');
    }

    fs.mkdirSync(outputDir, { recursive: true });
    const segmentDuration =
      options.segmentDuration ?? this.defaultSegmentDuration;
    await this.sliceVideoToHls(
      inputPath,
      outputDir,
      segmentDuration,
      options.cropFilter,
    );
    return await this.uploadHlsDirectory(outputDir);
  }

  // Uploads HLS segments to TikTok CDN and rewrites playlist files on disk.
  async uploadHlsDirectory(hlsDir: string): Promise<TikTokCdnUploadResult> {
    if (!this.validateConfig()) {
      throw new Error('TikTok CDN credentials are not configured.');
    }

    const tsFiles = this.findFilesRecursively(hlsDir, '.ts');
    if (tsFiles.length === 0) {
      throw new Error(`No .ts segments found in directory: ${hlsDir}`);
    }

    const uploadResults: SegmentUploadResult[] = [];
    const deadline = Date.now() + this.uploadBudgetMs;
    for (let i = 0; i < tsFiles.length; i += CDN_UPLOAD_CONCURRENCY) {
      uploadResults.push(
        ...(await this.uploadSegmentBatch(
          tsFiles.slice(i, i + CDN_UPLOAD_CONCURRENCY),
          deadline,
        )),
      );
    }

    return this.finishHlsUpload(hlsDir, uploadResults);
  }

  /**
   * Sends the segments of a directory that ffmpeg is still filling. The encoder writes a segment
   * under a temporary name and renames it when it is complete (hls_flags temp_file), so every
   * `.ts` file seen here is whole. Segments go out while the rest of the reel is encoded, and
   * `finish()` only has the last few left to send.
   *
   * While the encoder runs, a request is bounded by its own timeout and retries; the total budget
   * (`TIKTOK_CDN_UPLOAD_BUDGET_MS`) starts when `finish()` is called, so a long reel is not cut off
   * just because encoding it takes longer than the budget.
   */
  startHlsStreamingUpload(hlsDir: string): HlsStreamingUpload {
    if (!this.validateConfig()) {
      throw new Error('TikTok CDN credentials are not configured.');
    }

    const uploaded = new Map<string, SegmentUploadResult>();
    let stopped = false;
    let failure: unknown;
    let deadline: number | undefined;

    const sendNewSegments = async (honourStop: boolean): Promise<void> => {
      const waiting = this.findFilesRecursively(hlsDir, '.ts').filter(
        (file) => !uploaded.has(path.resolve(file)),
      );
      for (let i = 0; i < waiting.length; i += CDN_UPLOAD_CONCURRENCY) {
        if (honourStop && stopped) return;
        const results = await this.uploadSegmentBatch(
          waiting.slice(i, i + CDN_UPLOAD_CONCURRENCY),
          deadline,
        );
        for (const result of results) uploaded.set(result.localPath, result);
      }
    };

    const background = (async () => {
      while (!stopped) {
        try {
          await sendNewSegments(true);
        } catch (error: unknown) {
          failure = error;
          return;
        }
        if (!stopped) await this.pause(CDN_STREAMING_POLL_MS);
      }
    })();

    return {
      finish: async () => {
        stopped = true;
        await background;
        if (failure !== undefined) {
          throw failure instanceof Error
            ? failure
            : new Error('TikTok CDN streaming upload failed');
        }
        deadline = Date.now() + this.uploadBudgetMs;
        await sendNewSegments(false);
        return this.finishHlsUpload(hlsDir, [...uploaded.values()]);
      },
      abort: () => {
        stopped = true;
      },
    };
  }

  private async uploadSegmentBatch(
    files: string[],
    deadline: number | undefined,
  ): Promise<SegmentUploadResult[]> {
    return await Promise.all(
      files.map((filePath) =>
        this.uploadSegment(filePath, path.basename(filePath), deadline),
      ),
    );
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Points the playlists at the uploaded segments and removes the local copies.
  private finishHlsUpload(
    hlsDir: string,
    uploadResults: SegmentUploadResult[],
  ): TikTokCdnUploadResult {
    const tsFiles = this.findFilesRecursively(hlsDir, '.ts');
    if (tsFiles.length === 0) {
      throw new Error(`No .ts segments found in directory: ${hlsDir}`);
    }
    const missing = tsFiles.filter(
      (file) =>
        !uploadResults.some(
          (result) => result.localPath === path.resolve(file),
        ),
    );
    if (missing.length > 0) {
      throw new Error(
        `${missing.length} segment(s) were not uploaded to the TikTok CDN, first: ${path.basename(missing[0])}`,
      );
    }

    const m3u8Files = this.findFilesRecursively(hlsDir, '.m3u8');
    if (m3u8Files.length === 0) {
      throw new Error(`No .m3u8 playlist found in directory: ${hlsDir}`);
    }

    for (const m3u8Path of m3u8Files) {
      this.rewritePlaylistOnDisk(m3u8Path, uploadResults);
    }

    for (const tsFile of tsFiles) {
      try {
        fs.unlinkSync(tsFile);
      } catch (err) {
        this.logger.warn(
          `Failed to unlink uploaded segment ${tsFile}: ${String(err)}`,
        );
      }
    }

    const masterFile =
      m3u8Files.find((f) => path.basename(f) === 'master.m3u8') ||
      m3u8Files.find((f) => path.basename(f) === 'index.m3u8') ||
      m3u8Files[0];

    return {
      playlistContent: fs.readFileSync(masterFile, 'utf8'),
      segmentCount: uploadResults.length,
      segmentUrls: uploadResults.map((r) => r.remoteUrl),
    };
  }

  // Uploads image directly to TikTok CDN without masking.
  async uploadImage(
    imagePath: string,
    contentType?: string,
  ): Promise<TikTokCdnImageResult> {
    if (!this.validateConfig()) {
      throw new Error('TikTok CDN credentials are not configured.');
    }

    const filename = path.basename(imagePath);
    const detectedType =
      contentType || this.detectMimeType(filename) || 'image/jpeg';
    const data = fs.readFileSync(imagePath);
    const remoteUrl = await this.sendMultipartUpload(
      filename,
      data,
      detectedType,
    );

    return { cdnUrl: remoteUrl };
  }

  // Recursively finds all files matching a specific extension.
  private findFilesRecursively(dir: string, ext: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.findFilesRecursively(fullPath, ext));
      } else if (entry.name.endsWith(ext)) {
        results.push(fullPath);
      }
    }
    return results;
  }

  // Slices video to HLS with FFmpeg.
  private async sliceVideoToHls(
    inputPath: string,
    outputDir: string,
    segmentDuration: number,
    cropFilter?: string,
  ): Promise<void> {
    const m3u8Path = path.join(outputDir, 'index.m3u8');
    const args: string[] = ['-y', '-i', inputPath];

    if (cropFilter) {
      args.push(
        '-vf',
        cropFilter,
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        '23',
        '-c:a',
        'copy',
      );
    } else {
      args.push('-codec:', 'copy');
    }

    args.push(
      '-map_metadata',
      '-1',
      '-metadata',
      'service_provider=velora',
      '-metadata',
      'service_name=velora',
      '-start_number',
      '0',
      '-hls_time',
      segmentDuration.toString(),
      '-hls_list_size',
      '0',
      '-f',
      'hls',
      m3u8Path,
    );

    await this.runProcess(this.ffmpegPath, args);
  }

  // Uploads TS segment prepended with 67-byte PNG mask.
  private async acquireUploadSlot(): Promise<void> {
    if (this.activeUploads < this.maxParallelUploads) {
      this.activeUploads += 1;
      return;
    }
    await new Promise<void>((resolve) => this.uploadWaiters.push(resolve));
  }

  private releaseUploadSlot(): void {
    const next = this.uploadWaiters.shift();
    if (next) {
      next(); // the slot passes straight to the next waiter
    } else {
      this.activeUploads -= 1;
    }
  }

  private async uploadSegment(
    filePath: string,
    filename: string,
    deadline?: number,
  ): Promise<SegmentUploadResult> {
    await this.acquireUploadSlot();
    try {
      return await this.uploadSegmentNow(filePath, filename, deadline);
    } finally {
      this.releaseUploadSlot();
    }
  }

  private async uploadSegmentNow(
    filePath: string,
    filename: string,
    deadline?: number,
  ): Promise<SegmentUploadResult> {
    let tsData = fs.readFileSync(filePath);
    if (tsData.includes('FFmpeg')) {
      tsData = Buffer.from(tsData);
      let idx = 0;
      while ((idx = tsData.indexOf('FFmpeg', idx)) !== -1) {
        tsData.write('velora', idx);
        idx += 6;
      }
    }
    const originalSize = tsData.length;
    const spoofed = Buffer.concat([PNG_MASK, tsData]);
    const uploadFilename = filename.replace(/\.ts$/, '.png');

    const remoteUrl = await this.sendMultipartUpload(
      uploadFilename,
      spoofed,
      'image/png',
      deadline,
    );

    return {
      filename,
      localPath: path.resolve(filePath),
      remoteUrl,
      originalSize,
    };
  }

  // Rewrites playlist on disk with #EXT-X-BYTERANGE directives pointing to CDN URLs.
  private rewritePlaylistOnDisk(
    playlistPath: string,
    results: SegmentUploadResult[],
  ): void {
    let m3u8 = fs.readFileSync(playlistPath, 'utf8');

    m3u8 = m3u8
      .split(/\r?\n/u)
      .map((line) => {
        if (!line.trim() || line.startsWith('#')) return line;
        const localPath = path.resolve(path.dirname(playlistPath), line.trim());
        const result = results.find((upload) => upload.localPath === localPath);
        if (!result) return line;
        return `#EXT-X-BYTERANGE:${result.originalSize}@${PNG_MASK_SIZE}\n${result.remoteUrl}`;
      })
      .join('\n');

    m3u8 = m3u8.replace('#EXT-X-VERSION:3', '#EXT-X-VERSION:4');
    fs.writeFileSync(playlistPath, m3u8, 'utf8');
  }

  // Sends multipart upload directly to TikTok Ads API.
  /**
   * Sends one file, retrying a stalled or failed connection a couple of times. Only transport
   * problems (timeout, dropped connection, HTTP 5xx/429) are retried; a response that rejects the
   * upload (HTTP 4xx, `code` other than 0, for example the permission error of an expired session)
   * is final, because trying again cannot change the answer.
   */
  private async sendMultipartUpload(
    filename: string,
    fileBuffer: Buffer,
    contentType: string,
    deadline?: number,
  ): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.uploadRetries; attempt += 1) {
      try {
        return await this.sendMultipartUploadOnce(
          filename,
          fileBuffer,
          contentType,
          deadline,
        );
      } catch (error) {
        if (!(error instanceof CdnTransportError)) throw error;
        lastError = error;
        const backoff = CDN_RETRY_BACKOFF_MS * (attempt + 1);
        if (
          attempt === this.uploadRetries ||
          (deadline !== undefined && Date.now() + backoff >= deadline)
        ) {
          break;
        }
        this.logger.warn(
          `TikTok CDN upload of ${filename} failed (${error.message}); retry ${attempt + 1}/${this.uploadRetries}`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async sendMultipartUploadOnce(
    filename: string,
    fileBuffer: Buffer,
    contentType: string,
    deadline?: number,
  ): Promise<string> {
    const timeoutMs =
      deadline === undefined
        ? this.requestTimeoutMs
        : Math.min(this.requestTimeoutMs, deadline - Date.now());
    if (timeoutMs <= 0) {
      throw new Error(
        `TikTok CDN upload budget of ${this.uploadBudgetMs} ms exceeded before ${filename}`,
      );
    }
    const form = new FormData();
    const blob = new Blob([new Uint8Array(fileBuffer)], { type: contentType });
    form.append('Filedata', blob, filename);

    const headers: Record<string, string> = {
      'x-ttam-uuid': this.uuid,
      'x-csrftoken': this.csrfToken,
      Cookie: this.cookie,
    };

    let bodyText: string;
    let response: Response;
    try {
      response = await fetch(this.uploadEndpoint, {
        method: 'POST',
        headers,
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
      bodyText = await response.text();
    } catch (error) {
      if ((error as { name?: string } | null)?.name === 'TimeoutError') {
        throw new CdnTransportError(
          `TikTok CDN upload of ${filename} timed out after ${timeoutMs} ms`,
        );
      }
      throw new CdnTransportError(
        `TikTok CDN upload of ${filename} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      const message = `TikTok CDN HTTP ${response.status}: ${bodyText}`;
      throw response.status >= 500 || response.status === 429
        ? new CdnTransportError(message)
        : new Error(message);
    }

    let parsed: TikTokUploadApiResponse;
    try {
      parsed = JSON.parse(bodyText) as TikTokUploadApiResponse;
    } catch {
      throw new Error(`Failed to parse TikTok CDN response: ${bodyText}`);
    }

    if (parsed.code === 0 && parsed.data?.url) {
      return parsed.data.url;
    }

    throw new Error(`TikTok CDN rejected upload for ${filename}: ${bodyText}`);
  }

  private detectMimeType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    switch (ext) {
      case '.jpg':
      case '.jpeg':
        return 'image/jpeg';
      case '.png':
        return 'image/png';
      case '.webp':
        return 'image/webp';
      case '.gif':
        return 'image/gif';
      default:
        return 'application/octet-stream';
    }
  }

  private async runProcess(executable: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`),
          );
        }
      });

      child.on('error', (err) => {
        reject(new Error(`Failed to execute FFmpeg: ${err.message}`));
      });
    });
  }
}
