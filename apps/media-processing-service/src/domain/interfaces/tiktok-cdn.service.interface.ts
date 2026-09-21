export interface TikTokCdnUploadResult {
  playlistContent: string;
  segmentCount: number;
  segmentUrls: string[];
}

export interface TikTokCdnImageResult {
  cdnUrl: string;
}

export interface TikTokCdnProcessOptions {
  segmentDuration?: number;
  cropFilter?: string;
}

export interface ITikTokCdnService {
  /**
   * Slices video into HLS .ts segments and uploads them to TikTok CDN masked with 67-byte PNG headers.
   * Returns rewritten M3U8 playlist with #EXT-X-BYTERANGE:<size>@67 and TikTok CDN URLs.
   */
  processAndUploadVideoHls(
    inputPath: string,
    outputDir: string,
    options?: TikTokCdnProcessOptions,
  ): Promise<TikTokCdnUploadResult>;

  /**
   * Upload an existing directory of HLS segments (.ts) and index.m3u8 to TikTok CDN.
   * Returns rewritten M3U8 playlist with #EXT-X-BYTERANGE:<size>@67 and TikTok CDN URLs.
   */
  uploadHlsDirectory(
    hlsDir: string,
  ): Promise<TikTokCdnUploadResult>;

  /**
   * Upload an image directly to TikTok CDN without masking.
   */
  uploadImage(
    imagePath: string,
    contentType?: string,
  ): Promise<TikTokCdnImageResult>;

  /**
   * Validate that TikTok CDN credentials are configured.
   */
  validateConfig(): boolean;
}
