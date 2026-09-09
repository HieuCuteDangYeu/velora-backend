import { ConfigService } from '@nestjs/config';
import { RecommendationConfigService } from './recommendation-config.service';

describe('RecommendationConfigService', () => {
  it('defaults telemetry metadata to graph recommendation V2', () => {
    const service = new RecommendationConfigService(new ConfigService({}));

    expect(service.getAlgorithmVersion()).toBe(
      'graph-friend-recommendation-v2',
    );
    expect(service.getCandidateSource()).toBe('GRAPH_TWO_HOP');
  });

  it('accepts graph V2 experiment suffixes', () => {
    const service = new RecommendationConfigService(
      new ConfigService({
        USER_RECOMMENDATION_VERSION: 'graph-friend-recommendation-v2-exp-a',
      }),
    );

    expect(service.getAlgorithmVersion()).toBe(
      'graph-friend-recommendation-v2-exp-a',
    );
  });

  it('rejects a stale public fallback algorithm label', () => {
    expect(
      () =>
        new RecommendationConfigService(
          new ConfigService({
            USER_RECOMMENDATION_VERSION: 'public-user-fallback-v1',
          }),
        ),
    ).toThrow(
      'USER_RECOMMENDATION_VERSION must identify graph-friend-recommendation-v2',
    );
  });
});
