export interface TikTokCdnUploadResult {
  playlistContent: string;
  segmentCount: number;
  segmentUrls: string[];
}

export interface HlsStreamingUpload {
  /**
   * Sends the segments that are still left, points the playlists at the CDN and removes the local
   * segments. Rejects when any segment could not be uploaded; the files are then still on disk.
   */
  finish(): Promise<TikTokCdnUploadResult>;
  /** Stops sending. The local files are left as they are. */
  abort(): void;
}

export interface TikTokCdnImageResult {
  cdnUrl: string;
}

export interface TikTokCdnProcessOptions {
  segmentDuration?: number;
  cropFilter?: string;
}

export interface TikTokCdnPingResult {
  isAlive: boolean;
  message: string;
  statusCode?: number;
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

  // Uploads the segments of a directory ffmpeg is still writing, while it writes them.
  startHlsStreamingUpload(hlsDir: string): HlsStreamingUpload;

  // Uploads image directly to TikTok CDN.
  uploadImage(
    imagePath: string,
    contentType?: string,
  ): Promise<TikTokCdnImageResult>;

  // Validates required TikTok CDN credentials.
  validateConfig(): boolean;

  // Pings TikTok Ads API to keep session cookies alive.
  pingSession(): Promise<TikTokCdnPingResult>;
}
