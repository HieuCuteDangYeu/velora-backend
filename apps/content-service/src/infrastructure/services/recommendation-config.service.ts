import type { RecommendationFeatureFlags } from '@common/recommendation/interfaces/recommendation-metadata.interface';
import type { IRecommendationConfig } from '@content/domain/interfaces/recommendation-config.interface';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

@Injectable()
export class RecommendationConfigService implements IRecommendationConfig {
  private readonly algorithmVersion: string;
  private readonly telemetryEnabled: boolean;
  private readonly socialPoolEnabled: boolean;
  private readonly semanticPoolEnabled: boolean;
  private readonly feedSessionTtlSeconds: number;
  private readonly feedSlateSize: number;

  constructor(private readonly configService: ConfigService) {
    this.algorithmVersion = this.readVersion(
      'REEL_RECOMMENDATION_VERSION',
      'personalized-ranker-v2',
    );

    this.telemetryEnabled = this.readBoolean(
      'RECOMMENDATION_TELEMETRY_ENABLED',
      true,
    );

    this.socialPoolEnabled = this.readBoolean('REEL_SOCIAL_POOL_ENABLED', true);
    this.semanticPoolEnabled =
      this.readBoolean('REEL_SEMANTIC_POOL_ENABLED', true) &&
      this.readBoolean('RECOMMENDATION_SEMANTIC_INDEX_ENABLED', false);

    this.feedSessionTtlSeconds = this.readInteger(
      'REEL_FEED_SESSION_TTL_SECONDS',
      15 * 60,
      60,
      60 * 60,
    );
    this.feedSlateSize = this.readInteger(
      'REEL_FEED_SLATE_SIZE',
      100,
      20,
      200,
    );
  }

  getAlgorithmVersion(): string {
    return this.algorithmVersion;
  }

  getCandidateSource(): string {
    return 'PERSONALIZED_MULTI_SOURCE_PHASE8';
  }

  getFeatureFlags(): RecommendationFeatureFlags {
    return {
      recentQualityPool: true,
      trendingPool: true,
      tagAffinityPool: true,
      creatorAffinityPool: true,
      metadataSimilarityPool: true,
      semanticPool: this.semanticPoolEnabled,
      explorationPool: true,
      socialPool: this.socialPoolEnabled,
      personalizedRanking: true,
      sessionIntent: true,
      fatigueControl: true,
      diversityReranking: true,
      stableFeedSessionSlate: true,
    };
  }

  getFeedSessionTtlSeconds(): number {
    return this.feedSessionTtlSeconds;
  }

  getFeedSlateSize(): number {
    return this.feedSlateSize;
  }

  isTelemetryEnabled(): boolean {
    return this.telemetryEnabled;
  }

  private readVersion(key: string, fallback: string): string {
    const value = this.configService.get<string>(key)?.trim() || fallback;

    if (!VERSION_PATTERN.test(value)) {
      throw new Error(`${key} has an invalid value`);
    }

    return value;
  }

  private readBoolean(key: string, fallback: boolean): boolean {
    const value = this.configService.get<string | boolean>(key);

    if (value === undefined || value === null || value === '') {
      return fallback;
    }

    if (typeof value === 'boolean') {
      return value;
    }

    const normalized = value.trim().toLowerCase();

    if (['true', '1', 'yes', 'on'].includes(normalized)) {
      return true;
    }

    if (['false', '0', 'no', 'off'].includes(normalized)) {
      return false;
    }

    throw new Error(`${key} has an invalid boolean value`);
  }

  private readInteger(
    key: string,
    fallback: number,
    minimum: number,
    maximum: number,
  ): number {
    const raw = this.configService.get<string | number>(key);
    const value = raw === undefined || raw === null || raw === '' ? fallback : Number(raw);

    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${key} must be an integer between ${minimum} and ${maximum}`);
    }

    return value;
  }
}
