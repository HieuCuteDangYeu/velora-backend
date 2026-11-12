import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ClientProxy } from '@nestjs/microservices';
import { NEVER, of, throwError } from 'rxjs';
import { AiRecommendationRerankerAdapter } from './ai-recommendation-reranker.adapter';

describe('AiRecommendationRerankerAdapter', () => {
  const build = (
    send: jest.Mock,
    env: Record<string, string> = {},
  ): AiRecommendationRerankerAdapter =>
    new AiRecommendationRerankerAdapter(
      { send } as unknown as ClientProxy,
      new ConfigService(env),
    );

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('is disabled with bounded defaults unless the flag is set', () => {
    expect(build(jest.fn()).getSettings()).toEqual({
      enabled: false,
      topK: 20,
      weight: 0.15,
      timeoutMs: 3000,
      experimentEnabled: false,
      treatmentPercent: 50,
    });
  });

  it('clamps the configured settings', () => {
    expect(
      build(jest.fn(), {
        REEL_NEURAL_RERANK_ENABLED: 'true',
        REEL_NEURAL_RERANK_TOP_K: '900',
        REEL_NEURAL_RERANK_WEIGHT: '9',
        REEL_NEURAL_RERANK_TIMEOUT_MS: '1',
        REEL_NEURAL_RERANK_EXPERIMENT_ENABLED: 'true',
        REEL_NEURAL_RERANK_EXPERIMENT_TREATMENT_PERCENT: '250',
      }).getSettings(),
    ).toEqual({
      enabled: true,
      topK: 50,
      weight: 0.5,
      timeoutMs: 500,
      experimentEnabled: true,
      treatmentPercent: 100,
    });
  });

  it('sends the documents to ai.rerank_texts and returns the scores', async () => {
    const send = jest.fn().mockReturnValue(of({ scores: [0.2, 0.8] }));

    await expect(
      build(send).scoreDocuments({ queryText: 'q', documents: ['a', 'b'] }),
    ).resolves.toEqual([0.2, 0.8]);
    expect(send).toHaveBeenCalledWith('ai.rerank_texts', {
      queryText: 'q',
      texts: ['a', 'b'],
      budgetMs: 2400,
    });
  });

  it.each([
    ['a transport error', () => throwError(() => new Error('rmq down'))],
    ['a score count mismatch', () => of({ scores: [0.5] })],
    ['a non-finite score', () => of({ scores: [0.5, null] })],
  ])('returns null on %s so the caller keeps its order', async (_n, reply) => {
    await expect(
      build(jest.fn().mockImplementation(reply)).scoreDocuments({
        queryText: 'q',
        documents: ['a', 'b'],
      }),
    ).resolves.toBeNull();
  });

  it('gives up with null when ai-service does not answer in time', async () => {
    await expect(
      build(jest.fn().mockReturnValue(NEVER), {
        REEL_NEURAL_RERANK_TIMEOUT_MS: '500',
      }).scoreDocuments({ queryText: 'q', documents: ['a'] }),
    ).resolves.toBeNull();
  });
});
