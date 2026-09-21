import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ITikTokCdnService,
  TikTokCdnImageResult,
  TikTokCdnProcessOptions,
  TikTokCdnUploadResult,
} from '../../domain/interfaces/tiktok-cdn.service.interface';

/**
 * The complete, mathematically perfect 1x1 RGBA PNG (67 bytes).
 * Used as a prefix mask so the TikTok Ads CDN sees a valid PNG image header.
 */
const PNG_HEX =
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082';
const PNG_MASK = Buffer.from(PNG_HEX, 'hex');
const PNG_MASK_SIZE = 67;

interface SegmentUploadResult {
  filename: string;
  remoteUrl: string;
  originalSize: number;
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
    this.ffmpegPath =
      this.configService.get<string>('FFMPEG_PATH') || 'ffmpeg';
  }

  validateConfig(): boolean {
    return Boolean(
      this.uploadEndpoint && this.csrfToken && this.uuid && this.cookie,
    );
  }

  /**
   * Slices video into HLS .ts segments and uploads them to TikTok CDN masked as PNG.
   * Returns rewritten M3U8 playlist with #EXT-X-BYTERANGE:<size>@67 and TikTok CDN URLs.
   */
  async processAndUploadVideoHls(
    inputPath: string,
    outputDir: string,
    options: TikTokCdnProcessOptions = {},
  ): Promise<TikTokCdnUploadResult> {
    if (!this.validateConfig()) {
      throw new Error(
        'TikTok CDN credentials are not properly configured. Check TIKTOK_CDN_UPLOAD_ENDPOINT, TIKTOK_CDN_CSRF_TOKEN, TIKTOK_CDN_UUID, and TIKTOK_CDN_COOKIE.',
      );
    }

    fs.mkdirSync(outputDir, { recursive: true });

    const segmentDuration =
      options.segmentDuration ?? this.defaultSegmentDuration;
    this.logger.log(
      `Slicing video ${inputPath} to HLS (segmentDuration: ${segmentDuration}s, crop: ${options.cropFilter || 'none'})`,
    );

    await this.sliceVideoToHls(inputPath, outputDir, segmentDuration, options.cropFilter);

    return await this.uploadHlsDirectory(outputDir);
  }

  /**
   * Upload an existing directory of HLS segments (.ts) and index.m3u8 to TikTok CDN.
   * Returns rewritten M3U8 playlist with #EXT-X-BYTERANGE:<size>@67 and TikTok CDN URLs.
   */
  async uploadHlsDirectory(hlsDir: string): Promise<TikTokCdnUploadResult> {
    if (!this.validateConfig()) {
      throw new Error('TikTok CDN credentials are not configured.');
    }

    const files = fs.readdirSync(hlsDir);
    const tsFiles = files
      .filter((file) => file.endsWith('.ts'))
      .sort((a, b) => {
        // Natural numeric sort: index0.ts, index1.ts, index2.ts, ...
        const numA = parseInt(a.replace(/\D/g, ''), 10) || 0;
        const numB = parseInt(b.replace(/\D/g, ''), 10) || 0;
        return numA - numB;
      });

    if (tsFiles.length === 0) {
      throw new Error(`No .ts segments found in directory: ${hlsDir}`);
    }

    this.logger.log(`Found ${tsFiles.length} HLS segments to upload to TikTok CDN`);

    // Upload segments with controlled concurrency (3 parallel uploads)
    const uploadResults: SegmentUploadResult[] = [];
    const concurrency = 3;

    for (let i = 0; i < tsFiles.length; i += concurrency) {
      const batch = tsFiles.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(async (filename) => {
          const filePath = path.join(hlsDir, filename);
          return await this.uploadSegment(filePath, filename);
        }),
      );
      uploadResults.push(...batchResults);
    }

    // Locate playlist file
    const playlistFile = files.find(
      (f) => f === 'index.m3u8' || f === 'master.m3u8' || f.endsWith('.m3u8'),
    );
    if (!playlistFile) {
      throw new Error(`No .m3u8 playlist found in directory: ${hlsDir}`);
    }

    const playlistPath = path.join(hlsDir, playlistFile);
    const rewrittenM3u8 = this.rewritePlaylist(playlistPath, uploadResults);

    const segmentUrls = uploadResults.map((r) => r.remoteUrl);

    this.logger.log(
      `Successfully processed and uploaded ${uploadResults.length} segments to TikTok CDN`,
    );

    return {
      playlistContent: rewrittenM3u8,
      segmentCount: uploadResults.length,
      segmentUrls,
    };
  }

  /**
   * Upload an image directly to TikTok CDN without masking.
   */
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

    this.logger.log(`Uploading image ${filename} (${data.length} bytes) to TikTok CDN`);

    const remoteUrl = await this.sendMultipartUpload(
      filename,
      data,
      detectedType,
    );

    return { cdnUrl: remoteUrl };
  }

  /**
   * Slice video into MPEG-TS segments using FFmpeg.
   */
  private async sliceVideoToHls(
    inputPath: string,
    outputDir: string,
    segmentDuration: number,
    cropFilter?: string,
  ): Promise<void> {
    const m3u8Path = path.join(outputDir, 'index.m3u8');

    const args: string[] = ['-y', '-i', inputPath];

    if (cropFilter) {
      // Re-encode video with crop filter
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
      // Fast stream copy (no re-encoding)
      args.push('-codec:', 'copy');
    }

    // Strip metadata, set HLS parameters
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

  /**
   * Upload a single TS segment prepended with the 67-byte PNG mask.
   */
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

    // Prepend the 67-byte PNG mask to the TS data
    const spoofed = Buffer.concat([PNG_MASK, tsData]);
    const uploadFilename = filename.replace(/\.ts$/, '.png');

    const remoteUrl = await this.sendMultipartUpload(
      uploadFilename,
      spoofed,
      'image/png',
    );

    this.logger.log(
      `Uploaded segment ${filename} (${originalSize} bytes + ${PNG_MASK_SIZE} mask) -> ${remoteUrl.substring(0, 80)}...`,
    );

    return {
      filename,
      remoteUrl,
      originalSize,
    };
  }

  /**
   * Rewrite M3U8 playlist with #EXT-X-BYTERANGE:<size>@67 directives pointing to remote CDN URLs.
   */
  private rewritePlaylist(
    playlistPath: string,
    results: SegmentUploadResult[],
  ): string {
    let m3u8 = fs.readFileSync(playlistPath, 'utf8');

    for (const result of results) {
      // Replace local filename with BYTERANGE tag + remote URL
      // BYTERANGE: <size>@<offset> -> size = original TS bytes, offset = 67 (skip PNG header)
      const byterangeBlock = `#EXT-X-BYTERANGE:${result.originalSize}@${PNG_MASK_SIZE}\n${result.remoteUrl}`;
      m3u8 = m3u8.replace(result.filename, byterangeBlock);
    }

    // Upgrade HLS version to 4 for BYTERANGE support if version is 3
    m3u8 = m3u8.replace('#EXT-X-VERSION:3', '#EXT-X-VERSION:4');

    return m3u8;
  }

  /**
   * Sends multipart POST request directly to TikTok Ads Material Image Upload API.
   */
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
      throw new Error(
        `TikTok CDN HTTP ${response.status}: ${bodyText}`,
      );
    }

    let parsed: any;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      throw new Error(`Failed to parse TikTok CDN response: ${bodyText}`);
    }

    if (parsed.code === 0 && parsed.data?.url) {
      return parsed.data.url;
    }

    throw new Error(
      `TikTok CDN rejected upload for ${filename}: ${bodyText}`,
    );
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
      const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              `FFmpeg exited with code ${code}: ${stderr.slice(-500)}`,
            ),
          );
        }
      });

      child.on('error', (err) => {
        reject(new Error(`Failed to execute FFmpeg: ${err.message}`));
      });
    });
  }
}
