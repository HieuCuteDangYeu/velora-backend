import {
  missingRequiredReelEvidencePairs,
  ragRequestedFactSignalScore,
  validateRagAnswerContract,
} from './rag-answer-contract';

describe('missingRequiredReelEvidencePairs', () => {
  it('reports missing per-Reel modalities without treating another Reel as a substitute', () => {
    expect(
      missingRequiredReelEvidencePairs(
        [
          { reelId: 'reel-1', evidenceType: 'TRANSCRIPT' },
          { reelId: 'reel-1', evidenceType: 'VISUAL' },
          { reelId: 'reel-2', evidenceType: 'TRANSCRIPT' },
          { reelId: 'reel-2', evidenceType: 'VISUAL' },
          { reelId: 'reel-2', evidenceType: 'VISUAL' },
        ],
        ['reel-1', 'reel-2', 'reel-2'],
        ['TRANSCRIPT', 'VISUAL'],
      ),
    ).toEqual([]);
    expect(
      missingRequiredReelEvidencePairs(
        [
          { reelId: 'reel-1', evidenceType: 'TRANSCRIPT' },
          { reelId: 'reel-1', evidenceType: 'VISUAL' },
          { reelId: 'reel-2', evidenceType: 'TRANSCRIPT' },
        ],
        ['reel-1', 'reel-2'],
        ['TRANSCRIPT', 'VISUAL'],
      ),
    ).toEqual([{ reelId: 'reel-2', evidenceType: 'VISUAL' }]);
  });
});

describe('validateRagAnswerContract', () => {
  it.each(['at least 7', '7 or 8 years'])(
    'rejects incomplete requested duration %s',
    (answer) => {
      expect(
        validateRagAnswerContract({
          question: 'How long has he been waiting outside the community gate?',
          evidence: [
            'He has been waiting outside the community gate for at least 7 or 8 years.',
          ],
          answer,
          evidenceRequired: true,
        }),
      ).toBe('Answer model omitted a supported duration unit, range, or bound');
    },
  );
  it('accepts equivalent number words while retaining duration units and uncertainty', () => {
    expect(
      validateRagAnswerContract({
        question: 'How long has he been waiting outside the community gate?',
        evidence: [
          'He has been waiting outside the community gate for at least 7 or 8 years.',
        ],
        answer: 'At least seven or eight years.',
        evidenceRequired: true,
      }),
    ).toBeUndefined();
  });
  it('ranks the requested directional quantity above an unrelated quantity', () => {
    const question =
      'How low does the speaker say the number of bands can go while still being okay?';
    expect(
      ragRequestedFactSignalScore(
        question,
        'We can go down till like 12 bands and it is still okay.',
      ),
    ).toBeGreaterThan(
      ragRequestedFactSignalScore(
        question,
        'There are 2 controls on the panel.',
      ),
    );
  });
  it('rejects a competing quantity that does not satisfy the requested direction', () => {
    expect(
      validateRagAnswerContract({
        question: 'How low can the number of bands go while still being okay?',
        answer: 'The number of bands can go as low as 2.',
        evidence: [
          'There are 2 controls on the panel. We can go down till like 12 bands and it is still okay.',
        ],
        evidenceRequired: true,
      }),
    ).toBe(
      'Answer model used a quantity unsupported by the requested relation',
    );
  });

  it('accepts the quantity attached to the requested direction', () => {
    expect(
      validateRagAnswerContract({
        question: 'How low can the number of bands go while still being okay?',
        answer: 'Down to about twelve bands.',
        evidence: [
          'There are 2 controls on the panel. We can go down till like 12 bands and it is still okay.',
        ],
        evidenceRequired: true,
      }),
    ).toBeUndefined();
  });

  it('rejects a question token substituted for an exact requested label', () => {
    expect(
      validateRagAnswerContract({
        question:
          'What example label is used for a marble that is put into a bag?',
        answer: 'The example label used for the marble in the bag is bag.',
        evidence: [
          'This one is said to be blue, for example. I put it in the blue bag.',
        ],
        evidenceRequired: true,
      }),
    ).toBe('Answer model introduced an unsupported requested label or name');
  });

  it('does not require literal overlap for ordinary semantic paraphrases', () => {
    expect(
      validateRagAnswerContract({
        question: 'What safety measure protects the data from a building fire?',
        answer: 'They keep multiple backups in physically separate locations.',
        evidence: [
          'They will not keep it at one place. They have backup at different physical places.',
        ],
        evidenceRequired: true,
      }),
    ).toBeUndefined();
  });
});
