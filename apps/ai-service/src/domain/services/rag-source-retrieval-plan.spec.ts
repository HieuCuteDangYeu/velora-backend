import {
  requiresReelCoverage,
  sourceRetrievalPlan,
} from './rag-source-retrieval-plan';
import type { RagChatRouteDecision } from '../interfaces/rag-chat-workflow.interface';

const visual = {
  needsRetrieval: true,
  reelQuestionType: 'VISUAL_CONTENT',
  requiredEvidence: ['VISUAL'],
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
        {
          ...visual,
          reelQuestionType: 'TRANSCRIPT_CONTENT',
          requiredEvidence: ['TRANSCRIPT'],
        },
      ),
    ).toMatchObject({ sourceOrder: 'ASC', shouldRerank: false });
  });
  it('reads the first transcript segment chronologically for every Reel in a comparison', () => {
    expect(
      sourceRetrievalPlan(
        'Compare the first indexed transcript segments of "Episode 11" and "Episode 1". Attribute each statement to its own clip.',
        {
          ...visual,
          reelQuestionType: 'TRANSCRIPT_CONTENT',
          requiredEvidence: ['TRANSCRIPT'],
        },
      ),
    ).toMatchObject({
      sourceOrder: 'ASC',
      requiresReelCoverage: true,
      searchLimit: 1,
      rerankLimit: 1,
      shouldRerank: false,
    });
  });
  it('anchors an explicitly requested transcript segment to its source time', () => {
    expect(
      sourceRetrievalPlan(
        'What is said in the transcript segment spanning 11.68 seconds of the shared Reel?',
        {
          ...visual,
          reelQuestionType: 'TRANSCRIPT_CONTENT',
          requiredEvidence: ['TRANSCRIPT'],
        },
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
        {
          ...visual,
          reelQuestionType: 'TRANSCRIPT_CONTENT',
          requiredEvidence: ['TRANSCRIPT'],
        },
      ),
    ).toMatchObject({
      sourceOrder: 'ASC',
      sourceTimestampSec: 11.68,
      sourceTimestampEndSec: 56.38,
      searchLimit: 2,
      rerankLimit: 2,
    });
  });

  it('anchors transcript intervals phrased as indexed dialogue', () => {
    expect(
      sourceRetrievalPlan(
        'What does the prince say about the marriage? Refer to the indexed dialogue at 17.98-83.14 seconds.',
        {
          ...visual,
          reelQuestionType: 'TRANSCRIPT_CONTENT',
          requiredEvidence: ['TRANSCRIPT'],
        },
      ),
    ).toMatchObject({
      sourceOrder: 'ASC',
      sourceTimestampSec: 17.98,
      sourceTimestampEndSec: 83.14,
      searchLimit: 2,
      rerankLimit: 2,
    });
  });

  it('anchors transcript intervals phrased as indexed dialogue', () => {
    expect(
      sourceRetrievalPlan(
        'What does the prince say about the marriage? Refer to the indexed dialogue at 17.98-83.14 seconds.',
        {
          ...visual,
          reelQuestionType: 'TRANSCRIPT_CONTENT',
          requiredEvidence: ['TRANSCRIPT'],
        },
      ),
    ).toMatchObject({
      sourceOrder: 'ASC',
      sourceTimestampSec: 17.98,
      sourceTimestampEndSec: 83.14,
      searchLimit: 2,
      rerankLimit: 2,
    });
  });

  it('anchors transcript ranges described as indexed dialogue', () => {
    expect(
      sourceRetrievalPlan(
        'What does the prince say about the marriage? Refer to the indexed dialogue at 17.98-83.14 seconds.',
        {
          ...visual,
          reelQuestionType: 'TRANSCRIPT_CONTENT',
          requiredEvidence: ['TRANSCRIPT'],
        },
      ),
    ).toMatchObject({
      sourceOrder: 'ASC',
      sourceTimestampSec: 17.98,
      sourceTimestampEndSec: 83.14,
      searchLimit: 2,
      rerankLimit: 2,
    });
  });

  it('honors an explicit transcript time window when the router classifies it as a general summary', () => {
    expect(
      sourceRetrievalPlan(
        'Summarize what is said in the indexed transcript segment spanning 8–63.9 seconds.',
        {
          ...visual,
          reelQuestionType: 'GENERAL_REEL_SUMMARY',
          requiredEvidence: ['TRANSCRIPT', 'METADATA'],
        },
      ),
    ).toMatchObject({
      sourceOrder: 'ASC',
      transcriptTimestampSec: 8,
      transcriptTimestampEndSec: 63.9,
      sourceTimestampSec: 8,
      sourceTimestampEndSec: 63.9,
      searchLimit: 2,
      rerankLimit: 2,
    });
  });

  it('marks explicit comparisons for per-Reel evidence allocation', () => {
    expect(
      requiresReelCoverage('What is the difference between both shared Reels?'),
    ).toBe(true);
  });

  it('marks distinct episode references for per-Reel evidence allocation', () => {
    expect(
      requiresReelCoverage(
        'How does the narrator describe Episode 1, and what does William say in Episode 2?',
      ),
    ).toBe(true);
    expect(
      requiresReelCoverage('What does the narrator say in Episode 1?'),
    ).toBe(false);
    expect(
      requiresReelCoverage(
        'What does the narrator say in Episode 1 and Episode 1?',
      ),
    ).toBe(false);
  });

  it('marks different episode references for per-Reel allocation even without comparison wording', () => {
    expect(
      requiresReelCoverage(
        'How does the narrator describe Episode 1, and what does William say in Episode 2?',
      ),
    ).toBe(true);
    expect(
      requiresReelCoverage('What does the narrator say in Episode 1?'),
    ).toBe(false);
    expect(
      requiresReelCoverage(
        'What does the narrator say in Episode 1 and Episode 1?',
      ),
    ).toBe(false);
  });

  it('marks separate numbered episode references for per-Reel evidence allocation', () => {
    expect(
      requiresReelCoverage(
        'How does the narrator describe Episode 1, and what does William say in Episode 2?',
      ),
    ).toBe(true);
    expect(
      requiresReelCoverage('What does the narrator say in Episode 1?'),
    ).toBe(false);
    expect(
      requiresReelCoverage(
        'What does the narrator say in Episode 1 and Episode 1?',
      ),
    ).toBe(false);
  });
  it('uses a native dual-modality read for multimodal Reel questions', () => {
    expect(
      sourceRetrievalPlan(
        'What did the speaker say while the blue device was visible?',
        {
          ...visual,
          reelQuestionType: 'MULTIMODAL_CONTENT',
          requiredEvidence: ['TRANSCRIPT', 'VISUAL'],
        },
      ),
    ).toMatchObject({
      mode: 'REEL_HYBRID',
      searchLimit: 6,
      rerankLimit: 6,
      shouldRerank: false,
    });
  });

  it('keeps visual timestamps and transcript ranges independent', () => {
    const plan = sourceRetrievalPlan(
      'What is said in the transcript segment spanning 11.68-56.38 seconds while the frame at 33.25 seconds is visible?',
      {
        ...visual,
        reelQuestionType: 'MULTIMODAL_CONTENT',
        requiredEvidence: ['TRANSCRIPT', 'VISUAL'],
      },
    );
    expect(plan).toMatchObject({
      sourceOrder: 'ASC',
      visualTimestampSec: 33.25,
      transcriptTimestampSec: 11.68,
      transcriptTimestampEndSec: 56.38,
      searchLimit: 2,
    });
    expect(plan).not.toHaveProperty('sourceTimestampSec');
    expect(plan).not.toHaveProperty('sourceTimestampEndSec');
  });

  it('extracts an explicit visual timestamp phrased as "the frame is at"', () => {
    const plan = sourceRetrievalPlan(
      'Describe the visible expression, then say what the transcript segment spanning 24.5–82.14 seconds says. The frame is at 80 seconds.',
      {
        ...visual,
        reelQuestionType: 'MULTIMODAL_CONTENT',
        requiredEvidence: ['TRANSCRIPT', 'VISUAL'],
      },
    );
    expect(plan).toMatchObject({
      mode: 'REEL_HYBRID',
      visualTimestampSec: 80,
      transcriptTimestampSec: 24.5,
      transcriptTimestampEndSec: 82.14,
      searchLimit: 2,
    });
    expect(plan).not.toHaveProperty('sourceTimestampSec');
    expect(plan).not.toHaveProperty('sourceTimestampEndSec');
  });

  it('uses a sampled-frame time to locate the speech concurrent with that frame', () => {
    expect(
      sourceRetrievalPlan(
        'At the sampled frame at 33.25 seconds, what is the speaker saying?',
        {
          ...visual,
          reelQuestionType: 'MULTIMODAL_CONTENT',
          requiredEvidence: ['TRANSCRIPT', 'VISUAL'],
        },
      ),
    ).toMatchObject({
      visualTimestampSec: 33.25,
      transcriptTimestampSec: 33.25,
      searchLimit: 6,
    });
  });
});
