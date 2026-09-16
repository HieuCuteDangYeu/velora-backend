import {
  ragRequestedFactSignalScore,
  validateRagAnswerContract,
} from './rag-answer-contract';

describe('validateRagAnswerContract', () => {
  it('ranks the requested directional quantity above an unrelated quantity', () => {
    const question =
      'How low does the speaker say the number of bands can go while still being okay?';
    expect(
      ragRequestedFactSignalScore(
        question,
        'We can go down till like 12 bands and it is still okay.',
      ),
    ).toBeGreaterThan(
      ragRequestedFactSignalScore(question, 'There are 2 controls on the panel.'),
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
