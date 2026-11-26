import {
  isLongRangeTurn,
  markLongRangeTurn,
  runTurnScope,
} from './long-range-turn';
import {
  DEFAULT_RAG_PROMPT_BOUNDS,
  transcriptSegmentPromptBounds,
} from './rag-prompt-bounds';

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('long-range turn scope', () => {
  it('is false outside a turn and marking outside a turn does nothing', () => {
    markLongRangeTurn();
    expect(isLongRangeTurn()).toBe(false);
  });

  it('stays marked across awaits for the rest of the turn only', async () => {
    await runTurnScope(async () => {
      expect(isLongRangeTurn()).toBe(false);
      markLongRangeTurn();
      await tick();
      expect(isLongRangeTurn()).toBe(true);
    });
    expect(isLongRangeTurn()).toBe(false);
  });

  it('keeps concurrent turns apart', async () => {
    const seen: boolean[] = [];
    await Promise.all([
      runTurnScope(async () => {
        markLongRangeTurn();
        await tick();
        seen[0] = isLongRangeTurn();
      }),
      runTurnScope(async () => {
        await tick();
        seen[1] = isLongRangeTurn();
      }),
    ]);
    expect(seen).toEqual([true, false]);
  });

  it('raises the summary evidence limits only for a long-range turn', async () => {
    const normal = transcriptSegmentPromptBounds(
      DEFAULT_RAG_PROMPT_BOUNDS,
      'SUMMARY',
    );
    expect(normal.maxEvidenceItems).toBe(
      DEFAULT_RAG_PROMPT_BOUNDS.maxEvidenceItems,
    );
    expect(normal.maxEvidenceTotalChars).toBe(3_000);
    await runTurnScope(async () => {
      markLongRangeTurn();
      await tick();
      const long = transcriptSegmentPromptBounds(
        DEFAULT_RAG_PROMPT_BOUNDS,
        'SUMMARY',
      );
      expect(long.maxEvidenceItems).toBe(120);
      expect(long.maxEvidenceTotalChars).toBe(16_000);
      const comparison = transcriptSegmentPromptBounds(
        DEFAULT_RAG_PROMPT_BOUNDS,
        'MULTI_REEL_COMPARISON',
      );
      expect(comparison.maxEvidenceTotalChars).toBe(3_000);
    });
  });
});
