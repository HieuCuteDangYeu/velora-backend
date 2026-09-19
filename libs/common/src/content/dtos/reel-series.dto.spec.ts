import { AddReelToSeriesSchema } from './reel-series.dto';

describe('AddReelToSeriesSchema', () => {
  it('accepts a unique ordered reelIds batch', () => {
    expect(
      AddReelToSeriesSchema.safeParse({ reelIds: ['reel-1', 'reel-2'] })
        .success,
    ).toBe(true);
  });

  it('rejects the legacy single reelId payload and duplicate ids', () => {
    expect(AddReelToSeriesSchema.safeParse({ reelId: 'reel-1' }).success).toBe(
      false,
    );
    expect(
      AddReelToSeriesSchema.safeParse({ reelIds: ['reel-1', 'reel-1'] })
        .success,
    ).toBe(false);
  });
});
