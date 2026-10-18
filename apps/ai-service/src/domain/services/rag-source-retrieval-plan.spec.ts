import {
  requiresReelCoverage,
  sourceRetrievalPlan,
} from './rag-source-retrieval-plan';
import type { RagChatRouteDecision } from '../interfaces/rag-chat-workflow.interface';

const visual = {
  needsRetrieval: true,
  reelQuestionType: 'VISUAL_CONTENT',
} as RagChatRouteDecision;

describe('source retrieval constraints', () => {
  it('retains a user-provided zero timestamp', () => {
    expect(
      sourceRetrievalPlan(
        'What is visible in the sampled frame at 0 seconds?',
        visual,
      ),
    ).toMatchObject({
      sourceOrder: 'ASC',
      sourceTimestampSec: 0,
      shouldRerank: false,
      searchLimit: 1,
    });
  });
  it('does not invent a scene target for an unanchored question', () => {
    expect(
      sourceRetrievalPlan('What does the sampled visual scene show?', visual),
    ).toBeUndefined();
  });
  it('does not reinterpret transcript intent as visual intent', () => {
    expect(
      sourceRetrievalPlan('Describe the frame at 10 seconds.', {
        ...visual,
        reelQuestionType: 'TRANSCRIPT_CONTENT',
      }),
    ).toBeUndefined();
  });
  it('recognizes an explicitly requested first complete indexed sentence', () => {
    expect(
      sourceRetrievalPlan(
        'What is the first complete sentence recorded in the indexed transcript?',
        { ...visual, reelQuestionType: 'TRANSCRIPT_CONTENT' },
      ),
    ).toMatchObject({ sourceOrder: 'ASC', shouldRerank: false });
  });
  it('anchors an explicitly requested transcript segment to its source time', () => {
    expect(
      sourceRetrievalPlan(
        'What is said in the transcript segment spanning 11.68 seconds of the shared Reel?',
        { ...visual, reelQuestionType: 'TRANSCRIPT_CONTENT' },
      ),
    ).toMatchObject({
      sourceOrder: 'ASC',
      sourceTimestampSec: 11.68,
      searchLimit: 1,
      shouldRerank: false,
    });
  });
  it('preserves an explicit transcript time window', () => {
    expect(
      sourceRetrievalPlan(
        'Summarize the transcript segment spanning 11.68–56.38 seconds of the shared Reel.',
        { ...visual, reelQuestionType: 'TRANSCRIPT_CONTENT' },
      ),
    ).toMatchObject({
      sourceOrder: 'ASC',
      sourceTimestampSec: 11.68,
      sourceTimestampEndSec: 56.38,
      searchLimit: 2,
      rerankLimit: 2,
    });
  });

  it('marks explicit comparisons for per-Reel evidence allocation', () => {
    expect(
      requiresReelCoverage('What is the difference between both shared Reels?'),
    ).toBe(true);
  });
  it('uses a native dual-modality read for multimodal Reel questions', () => {
    expect(
      sourceRetrievalPlan(
        'What did the speaker say while the blue device was visible?',
        { ...visual, reelQuestionType: 'MULTIMODAL_CONTENT' },
      ),
    ).toMatchObject({
      mode: 'REEL_HYBRID',
      searchLimit: 6,
      rerankLimit: 6,
      shouldRerank: false,
    });
  });
});
