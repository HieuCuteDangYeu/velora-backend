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
  // Slices video to HLS and uploads segments to TikTok CDN.
  processAndUploadVideoHls(
    inputPath: string,
    outputDir: string,
    options?: TikTokCdnProcessOptions,
  ): Promise<TikTokCdnUploadResult>;

  // Uploads existing HLS directory segments to TikTok CDN and returns rewritten M3U8.
  uploadHlsDirectory(hlsDir: string): Promise<TikTokCdnUploadResult>;

  // Uploads image directly to TikTok CDN.
  uploadImage(
    imagePath: string,
    contentType?: string,
  ): Promise<TikTokCdnImageResult>;

  // Validates required TikTok CDN credentials.
  validateConfig(): boolean;
}
