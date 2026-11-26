import { SharedReelEvidenceProbeAdapter } from './shared-reel-evidence-probe.adapter';

const vector = { values: [0.1], model: 'm', version: 'v', dimensions: 1 };
const build = (hits: unknown[] | Error, threshold?: string) => {
  const searchChunks = jest.fn(() =>
    hits instanceof Error ? Promise.reject(hits) : Promise.resolve(hits),
  );
  const adapter = new SharedReelEvidenceProbeAdapter(
    { generateVector: jest.fn().mockResolvedValue(vector) } as never,
    { searchChunks } as never,
    {
      get: (key: string) =>
        key === 'AI_ROUTER_EVIDENCE_PROBE_MAX_DISTANCE' ? threshold : undefined,
    } as never,
  );
  return { adapter, searchChunks };
};
const ask = (adapter: SharedReelEvidenceProbeAdapter) =>
  adapter.hasStrongEvidence({
    message: 'What do AI companies admit happens to the filters?',
    accessibleReelIds: ['reel-1'],
  });

describe('SharedReelEvidenceProbeAdapter', () => {
  it('is true when a chunk of a shared reel is close, and scopes the search to the shared reels', async () => {
    const { adapter, searchChunks } = build([{ vectorDistance: 0.36 }]);
    await expect(ask(adapter)).resolves.toBe(true);
    expect(searchChunks).toHaveBeenCalledWith(
      expect.objectContaining({ filters: { reelIds: ['reel-1'] } }),
    );
  });

  it('is true at the calibrated limit (0.55) and false just past it', async () => {
    await expect(ask(build([{ vectorDistance: 0.55 }]).adapter)).resolves.toBe(
      true,
    );
    await expect(ask(build([{ vectorDistance: 0.56 }]).adapter)).resolves.toBe(
      false,
    );
  });

  it('accepts the closest chunk of a French or Korean question that sat at 0.52-0.54', async () => {
    for (const distance of [0.496, 0.522, 0.536, 0.542]) {
      await expect(
        ask(build([{ vectorDistance: distance }]).adapter),
      ).resolves.toBe(true);
    }
  });

  it('is false when the closest chunk is unrelated', async () => {
    const { adapter } = build([
      { vectorDistance: 0.58 },
      { vectorDistance: 0.62 },
    ]);
    await expect(ask(adapter)).resolves.toBe(false);
  });

  it('honours the configured distance', async () => {
    await expect(
      ask(build([{ vectorDistance: 0.6 }], '0.65').adapter),
    ).resolves.toBe(true);
  });

  it('is false, not an error, when the search fails or there is nothing to search', async () => {
    await expect(ask(build(new Error('qdrant down')).adapter)).resolves.toBe(
      false,
    );
    await expect(
      build([]).adapter.hasStrongEvidence({
        message: 'x?',
        accessibleReelIds: [],
      }),
    ).resolves.toBe(false);
  });

  describe('with the reranker as a second signal for the ambiguous band', () => {
    const vectorHit = (distance: number) => ({
      id: 'c1',
      reelId: 'reel-1',
      evidenceText: 'An excerpt of the transcript.',
      vectorDistance: distance,
    });
    const withReranker = (
      hits: unknown[],
      rerank: jest.Mock,
      values: Record<string, string> = {
        AI_ROUTER_EVIDENCE_PROBE_RERANK: 'true',
      },
    ) => {
      const adapter = new SharedReelEvidenceProbeAdapter(
        { generateVector: jest.fn().mockResolvedValue(vector) } as never,
        { searchChunks: jest.fn().mockResolvedValue(hits) } as never,
        { get: (key: string) => values[key] } as never,
        { rerank },
      );
      return { adapter, rerank };
    };

    it('searches for 6 excerpts and reranks up to 6 of them when the reranker check is switched on, and 3 otherwise', async () => {
      const searchOn = jest
        .fn()
        .mockResolvedValue(Array.from({ length: 6 }, () => vectorHit(0.5)));
      const rerank = jest.fn().mockResolvedValue([{ rerankScore: 0.5 }]);
      const on = new SharedReelEvidenceProbeAdapter(
        { generateVector: jest.fn().mockResolvedValue(vector) } as never,
        { searchChunks: searchOn } as never,
        {
          get: (key: string) =>
            key === 'AI_ROUTER_EVIDENCE_PROBE_RERANK' ? 'true' : undefined,
        } as never,
        { rerank },
      );
      await ask(on);
      expect(searchOn).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 6 }),
      );
      expect(rerank.mock.calls[0][0].candidates).toHaveLength(6);
      const off = build([{ vectorDistance: 0.3 }]);
      await ask(off.adapter);
      expect(off.searchChunks).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 3 }),
      );
    });

    it('reranks hits beyond the distance limit too, because the excerpt that answers a question can sit there', async () => {
      const rerank = jest.fn().mockResolvedValue([{ rerankScore: 0.34 }]);
      const { adapter } = withReranker(
        [vectorHit(0.536), vectorHit(0.546), vectorHit(0.575)],
        rerank,
      );
      await expect(ask(adapter)).resolves.toBe(true);
      expect(rerank.mock.calls[0][0].candidates).toHaveLength(3);
    });

    it('does not call the reranker when the closest excerpt is within the soft distance', async () => {
      const { adapter, rerank } = withReranker([vectorHit(0.44)], jest.fn());
      await expect(ask(adapter)).resolves.toBe(true);
      expect(rerank).not.toHaveBeenCalled();
    });

    it('reroutes a moderately far excerpt only when the reranker finds it relevant', async () => {
      const relevant = withReranker(
        [vectorHit(0.52)],
        jest.fn().mockResolvedValue([{ rerankScore: 0.6 }]),
      );
      await expect(ask(relevant.adapter)).resolves.toBe(true);
      const irrelevant = withReranker(
        [vectorHit(0.482)],
        jest.fn().mockResolvedValue([{ rerankScore: 0.0263 }]),
      );
      await expect(ask(irrelevant.adapter)).resolves.toBe(false);
    });

    it('stays with the distance alone when the reranker fails, returns no score, or is not switched on', async () => {
      const failing = withReranker(
        [vectorHit(0.5)],
        jest.fn().mockRejectedValue(new Error('429')),
      );
      await expect(ask(failing.adapter)).resolves.toBe(true);
      const unscored = withReranker(
        [vectorHit(0.5)],
        jest.fn().mockResolvedValue([{}]),
      );
      await expect(ask(unscored.adapter)).resolves.toBe(true);
      const off = withReranker(
        [vectorHit(0.5)],
        jest.fn().mockResolvedValue([{ rerankScore: 0.0 }]),
        {},
      );
      await expect(ask(off.adapter)).resolves.toBe(true);
      expect(off.rerank).not.toHaveBeenCalled();
    });

    it('honours the configured floor', async () => {
      const { adapter } = withReranker(
        [vectorHit(0.5)],
        jest.fn().mockResolvedValue([{ rerankScore: 0.03 }]),
        {
          AI_ROUTER_EVIDENCE_PROBE_RERANK: 'true',
          AI_ROUTER_EVIDENCE_PROBE_MIN_RERANK: '0.02',
        },
      );
      await expect(ask(adapter)).resolves.toBe(true);
    });
  });

  describe('with the remote scope check', () => {
    const hit = (distance: number) => ({
      id: 'c1',
      reelId: 'reel-1',
      evidenceText: 'Half a teaspoon of sugar goes into the flour.',
      vectorDistance: distance,
    });
    const withScope = (
      hits: unknown[],
      generateObject: jest.Mock,
      values: Record<string, string> = { AI_CLOUDFLARE_LLM_ENABLED: 'true' },
    ) => {
      const searchChunks = jest.fn().mockResolvedValue(hits);
      const adapter = new SharedReelEvidenceProbeAdapter(
        { generateVector: jest.fn().mockResolvedValue(vector) } as never,
        { searchChunks } as never,
        { get: (key: string) => values[key] } as never,
        undefined,
        { generateObject } as never,
      );
      return { adapter, generateObject, searchChunks };
    };

    it('reroutes a near question only when the remote model says it is about the video', async () => {
      const video = withScope(
        [hit(0.47)],
        jest.fn().mockResolvedValue({ about: 'VIDEO' }),
      );
      await expect(ask(video.adapter)).resolves.toBe(true);
      expect(video.searchChunks).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 6 }),
      );
      expect(video.generateObject.mock.calls[0][0].userPrompt).toContain(
        'Half a teaspoon of sugar',
      );
      const general = withScope(
        [hit(0.3)],
        jest.fn().mockResolvedValue({ about: 'GENERAL' }),
      );
      await expect(ask(general.adapter)).resolves.toBe(false);
    });

    it('does not ask when nothing is near', async () => {
      const far = withScope([hit(0.7)], jest.fn());
      await expect(ask(far.adapter)).resolves.toBe(false);
      expect(far.generateObject).not.toHaveBeenCalled();
    });

    it('falls back to the distance when the check fails, answers nothing usable, or is off', async () => {
      const failing = withScope(
        [hit(0.47)],
        jest.fn().mockRejectedValue(new Error('429')),
      );
      await expect(ask(failing.adapter)).resolves.toBe(true);
      const odd = withScope([hit(0.47)], jest.fn().mockResolvedValue({}));
      await expect(ask(odd.adapter)).resolves.toBe(true);
      for (const values of [
        {},
        {
          AI_CLOUDFLARE_LLM_ENABLED: 'true',
          AI_ROUTER_EVIDENCE_PROBE_SCOPE_CHECK: 'false',
        },
      ]) {
        const off = withScope([hit(0.47)], jest.fn(), values);
        await expect(ask(off.adapter)).resolves.toBe(true);
        expect(off.generateObject).not.toHaveBeenCalled();
      }
    });
  });
});
