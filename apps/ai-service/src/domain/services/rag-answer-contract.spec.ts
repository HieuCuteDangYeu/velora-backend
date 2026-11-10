import {
  MULTI_REEL_TRANSCRIPT_COMPARISON_MAX_CHARS,
  missingRequiredReelEvidencePairs,
  ragAnswerBudget,
  ragLacksRequestedQuantity,
  ragRequestedFactSignalScore,
  validateRagAnswerContract,
} from './rag-answer-contract';

describe('ragAnswerBudget', () => {
  it('gives first-segment multi-Reel comparisons enough room for both attributed passages', () => {
    expect(
      ragAnswerBudget('TRANSCRIPT_CONTENT', {
        multiReelTranscriptComparison: true,
      }),
    ).toEqual({
      shape: 'SUMMARY',
      maxChars: MULTI_REEL_TRANSCRIPT_COMPARISON_MAX_CHARS,
    });
    expect(ragAnswerBudget('TRANSCRIPT_CONTENT')).toEqual({
      shape: 'EXPLANATION',
      maxChars: 900,
    });
    expect(
      ragAnswerBudget('MULTIMODAL_CONTENT', {
        transcriptSummaryMaxChars: 3_000,
      }),
    ).toEqual({ shape: 'SUMMARY', maxChars: 3_000 });
  });
});

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

  describe('a turn with no evidence to check against', () => {
    // An ordinary chat turn has no reel evidence. A requested label or name cannot be
    // "supported by the evidence" there, so it must not fail the turn.
    it.each([
      [
        'What is the meaning of the word "ephemeral"?',
        'It means lasting a very short time.',
      ],
      [
        'What is the name of the capital of France?',
        'The capital of France is Paris.',
      ],
      ['What is the term for a baby cat?', 'A baby cat is called a kitten.'],
      ['What is the code for Vietnam on a phone call?', 'It is +84.'],
    ])('accepts a general answer to %s', (question, answer) => {
      expect(
        validateRagAnswerContract({
          question,
          answer,
          evidence: [],
          evidenceRequired: false,
        }),
      ).toBeUndefined();
    });

    it('still requires the named value to come from the evidence when evidence exists', () => {
      expect(
        validateRagAnswerContract({
          question: 'What is the name of the product in the clip?',
          answer: 'It is called the Zephyr X.',
          evidence: ['The presenter holds up a blue bottle.'],
          evidenceRequired: true,
        }),
      ).toBe('Answer model introduced an unsupported requested label or name');
    });
  });
});

describe('ragLacksRequestedQuantity', () => {
  const question =
    'What number or quantity is mentioned in the early transcript?';

  it('flags a sentence without a number when a quantity is requested', () => {
    expect(ragLacksRequestedQuantity(question, 'Hold on, everyone!')).toBe(
      true,
    );
  });

  it('accepts digits and number words', () => {
    expect(ragLacksRequestedQuantity(question, 'There are 10,000 here.')).toBe(
      false,
    );
    expect(ragLacksRequestedQuantity(question, 'He waited seven years.')).toBe(
      false,
    );
  });

  it('never flags a question that does not ask for a quantity', () => {
    expect(
      ragLacksRequestedQuantity('What does he say first?', 'Hold on!'),
    ).toBe(false);
  });
});

describe('validateRagAnswerContract opening quote', () => {
  const input = {
    answer: 'Episode 11 of The abandoned human girl.',
    question:
      'What is the opening statement in "The abandoned human girl Episode 11"?',
    evidence: ['Episode 11 of The abandoned human girl. Welcome back.'],
    evidenceRequired: true,
  };

  it('rejects a title restatement as a question echo by default', () => {
    expect(validateRagAnswerContract(input)).toMatch(/repeated the question/);
  });

  it('accepts it when the answer is a verbatim opening quote', () => {
    expect(
      validateRagAnswerContract({ ...input, verbatimOpeningQuote: true }),
    ).toBeUndefined();
  });

  it('still enforces the other checks for an opening quote', () => {
    expect(
      validateRagAnswerContract({
        ...input,
        answer: '',
        verbatimOpeningQuote: true,
      }),
    ).toMatch(/empty/);
  });
});
