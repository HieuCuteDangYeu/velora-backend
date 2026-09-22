import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
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

interface SegmentUploadResult {
  filename: string;
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

@Injectable()
export class TikTokCdnService implements ITikTokCdnService {
  private readonly logger = new Logger(TikTokCdnService.name);
  private readonly uploadEndpoint: string;
  private readonly csrfToken: string;
  private readonly uuid: string;
  private readonly cookie: string;
  private readonly defaultSegmentDuration: number;
  private readonly ffmpegPath: string;

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
    const concurrency = 3;

    for (let i = 0; i < tsFiles.length; i += concurrency) {
      const batch = tsFiles.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(async (filePath) => {
          const filename = path.basename(filePath);
          return await this.uploadSegment(filePath, filename);
        }),
      );
      uploadResults.push(...batchResults);
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

    const masterContent = fs.readFileSync(masterFile, 'utf8');
    const segmentUrls = uploadResults.map((r) => r.remoteUrl);

    return {
      playlistContent: masterContent,
      segmentCount: uploadResults.length,
      segmentUrls,
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
  private async uploadSegment(
    filePath: string,
    filename: string,
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
    );

    return {
      filename,
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

    for (const result of results) {
      if (m3u8.includes(result.filename)) {
        const byterangeBlock = `#EXT-X-BYTERANGE:${result.originalSize}@${PNG_MASK_SIZE}\n${result.remoteUrl}`;
        m3u8 = m3u8.replace(result.filename, byterangeBlock);
      }
    }

    m3u8 = m3u8.replace('#EXT-X-VERSION:3', '#EXT-X-VERSION:4');
    fs.writeFileSync(playlistPath, m3u8, 'utf8');
  }

  // Sends multipart upload directly to TikTok Ads API.
  private async sendMultipartUpload(
    filename: string,
    fileBuffer: Buffer,
    contentType: string,
  ): Promise<string> {
    const form = new FormData();
    const blob = new Blob([new Uint8Array(fileBuffer)], { type: contentType });
    form.append('Filedata', blob, filename);

    const headers: Record<string, string> = {
      'x-ttam-uuid': this.uuid,
      'x-csrftoken': this.csrfToken,
      Cookie: this.cookie,
    };

    const response = await fetch(this.uploadEndpoint, {
      method: 'POST',
      headers,
      body: form,
    });

    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`TikTok CDN HTTP ${response.status}: ${bodyText}`);
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
