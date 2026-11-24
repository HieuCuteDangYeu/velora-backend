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

  it('is true at the calibrated limit (0.48) and false just past it', async () => {
    await expect(ask(build([{ vectorDistance: 0.48 }]).adapter)).resolves.toBe(
      true,
    );
    await expect(ask(build([{ vectorDistance: 0.49 }]).adapter)).resolves.toBe(
      false,
    );
  });

  it('is false when the closest chunk is unrelated', async () => {
    const { adapter } = build([
      { vectorDistance: 0.55 },
      { vectorDistance: 0.6 },
    ]);
    await expect(ask(adapter)).resolves.toBe(false);
  });

  it('honours the configured distance', async () => {
    await expect(
      ask(build([{ vectorDistance: 0.55 }], '0.6').adapter),
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
});
