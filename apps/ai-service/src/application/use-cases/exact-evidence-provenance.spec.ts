import { assessExactEvidenceProvenance } from './exact-evidence-provenance';

describe('assessExactEvidenceProvenance', () => {
  it('accepts an exact contiguous source span without interpreting its language', () => {
    expect(
      assessExactEvidenceProvenance({
        answer: 'máy bơm ở tầng hầm',
        candidates: [
          {
            evidenceType: 'TRANSCRIPT',
            evidenceText: 'Họ nói máy bơm ở tầng hầm cạnh cửa sau.',
          },
        ],
      }),
    ).toEqual({ supported: true, supportingEvidenceIndexes: [0] });
  });

  it('rejects inserted or substituted tokens', () => {
    expect(
      assessExactEvidenceProvenance({
        answer: 'The ceramic turbine is in the eastern annex',
        candidates: [
          {
            evidenceType: 'TRANSCRIPT',
            evidenceText: 'The ceramic turbine is in the western annex.',
          },
        ],
      }).supported,
    ).toBe(false);
  });

  it('does not infer a relation from overlapping words', () => {
    expect(
      assessExactEvidenceProvenance({
        answer: 'Nila assigned the comet label',
        candidates: [
          {
            evidenceType: 'TRANSCRIPT',
            evidenceText: 'Nila reviewed the comet label assigned by Orin.',
          },
        ],
      }).supported,
    ).toBe(false);
  });

  it('accepts an extractive answer assembled from ordered evidence windows', () => {
    expect(
      assessExactEvidenceProvenance({
        answer: 'The first source window. The second source window.',
        candidates: [
          {
            evidenceType: 'TRANSCRIPT',
            evidenceText: 'The first source window.',
          },
          {
            evidenceType: 'TRANSCRIPT',
            evidenceText: 'The second source window.',
          },
        ],
      }),
    ).toEqual({ supported: true, supportingEvidenceIndexes: [0, 1] });
  });
});
