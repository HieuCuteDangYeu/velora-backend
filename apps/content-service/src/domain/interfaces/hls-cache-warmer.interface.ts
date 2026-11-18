export interface IHlsCacheWarmer {
  /**
   * Asks the CDN for the playlists and first segment of a freshly encoded reel so the first
   * viewer does not pay a cache miss on each of them. Fire and forget: it returns at once and
   * never throws.
   */
  warm(hlsMasterKey: string): void;
}
