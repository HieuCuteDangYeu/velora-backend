import type { IHlsCacheWarmer } from '@content/domain/interfaces/hls-cache-warmer.interface';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_VARIANTS = 6;

/**
 * A reel nobody has watched yet is not in the CDN's cache: the master playlist, the variant
 * playlist and the first segment each take 0.5-0.8 s to fetch from the origin, one after the
 * other, before the first frame (measured 2026-11-19: 60-84% of the catalog's first-touch
 * objects were misses, hits take about 55 ms). The files are immutable, so one request per
 * object warms it for good. This runs after the encode result is committed and asks the CDN
 * for them once, from the same region the viewers are served from.
 */
@Injectable()
export class CdnHlsCacheWarmerAdapter implements IHlsCacheWarmer {
  private readonly logger = new Logger(CdnHlsCacheWarmerAdapter.name);
  private readonly cdnDomain: string;
  private readonly enabled: boolean;

  constructor(config: ConfigService) {
    this.cdnDomain = (config.get<string>('R2_PUBLIC_DOMAIN') ?? '').replace(
      /\/+$/,
      '',
    );
    this.enabled =
      this.cdnDomain.length > 0 &&
      config.get<string>('HLS_CDN_WARM_ENABLED')?.trim().toLowerCase() !==
        'false';
  }

  warm(hlsMasterKey: string): void {
    if (!this.enabled || !hlsMasterKey.trim()) return;

    void this.warmMaster(
      `${this.cdnDomain}/${hlsMasterKey.replace(/^\/+/, '')}`,
    )
      .then((count) => {
        this.logger.debug(`Warmed ${count} CDN objects for ${hlsMasterKey}`);
      })
      .catch((error: unknown) => {
        this.logger.debug(
          `CDN warm-up of ${hlsMasterKey} skipped: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }

  private async warmMaster(masterUrl: string): Promise<number> {
    const master = await this.fetchText(masterUrl);
    let warmed = 1;

    const variants = this.uris(master).slice(0, MAX_VARIANTS);
    const results = await Promise.allSettled(
      variants.map(async (variant) => {
        const variantUrl = new URL(variant, masterUrl).toString();
        const playlist = await this.fetchText(variantUrl);
        const targets = [
          ...this.initUris(playlist),
          ...this.uris(playlist).slice(0, 1),
        ];
        // Range 0-0: the CDN still pulls and caches the whole object (checked) but only a byte
        // comes back to us.
        await Promise.all(
          targets.map((target) =>
            this.touch(new URL(target, variantUrl).toString()),
          ),
        );
        return 1 + targets.length;
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') warmed += result.value;
    }

    return warmed;
  }

  /** URI lines (not tags) of a playlist, in order. */
  private uris(playlist: string): string[] {
    return playlist
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  }

  /** fMP4 init segment from #EXT-X-MAP, if the playlist has one. */
  private initUris(playlist: string): string[] {
    const uri = /#EXT-X-MAP:[^\n]*URI="([^"]+)"/.exec(playlist)?.[1];
    return uri ? [uri] : [];
  }

  private async fetchText(url: string): Promise<string> {
    const response = await this.request(url);
    if (!response.ok) throw new Error(`${response.status} for ${url}`);
    return await response.text();
  }

  private async touch(url: string): Promise<void> {
    const response = await this.request(url, { Range: 'bytes=0-0' });
    await response.arrayBuffer().catch(() => undefined);
  }

  private async request(
    url: string,
    headers?: Record<string, string>,
  ): Promise<Response> {
    return await fetch(url, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }
}
