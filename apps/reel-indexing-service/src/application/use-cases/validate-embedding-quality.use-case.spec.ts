import type { ReelIndexDocument } from '@common/processing/interfaces/reel-index-document.interface';
import { ValidateEmbeddingQualityUseCase } from './validate-embedding-quality.use-case';

const document = (id: string, embedding: number[]): ReelIndexDocument =>
  ({
    id,
    kind: 'CHUNK',
    embedding,
    embeddingDimensions: embedding.length,
  }) as ReelIndexDocument;

describe('ValidateEmbeddingQualityUseCase', () => {
  const useCase = new ValidateEmbeddingQualityUseCase();

  it('accepts finite non-zero embeddings with matching dimensions', () => {
    expect(() =>
      useCase.execute({
        documents: [document('a', [0.2, 0.3]), document('b', [0.4, 0.1])],
        expectedDimensions: 2,
      }),
    ).not.toThrow();
  });

  it('rejects non-finite or zero embeddings', () => {
    expect(() =>
      useCase.execute({
        documents: [document('a', [Number.NaN, 0.2])],
        expectedDimensions: 2,
      }),
    ).toThrow(/non-finite/);

    expect(() =>
      useCase.execute({
        documents: [document('a', [0, 0])],
        expectedDimensions: 2,
      }),
    ).toThrow(/zero or invalid norm/);
  });

  it('rejects suspiciously duplicated embeddings', () => {
    const duplicate = [0.2, 0.3];
    expect(() =>
      useCase.execute({
        documents: Array.from({ length: 8 }, (_, index) =>
          document(String(index), index < 7 ? duplicate : [0.7, 0.1]),
        ),
        expectedDimensions: 2,
        maxDuplicateRatio: 0.5,
      }),
    ).toThrow(/duplicate ratio/);
  });

  it('accepts identical vectors that come from identical input text', () => {
    const repeated = (index: number): ReelIndexDocument =>
      ({
        ...document(String(index), [0.2, 0.3]),
        embeddingInputHash: 'same-description',
      }) as ReelIndexDocument;
    expect(() =>
      useCase.execute({
        documents: Array.from({ length: 8 }, (_, index) => repeated(index)),
        expectedDimensions: 2,
      }),
    ).not.toThrow();
  });

  it('still rejects identical vectors for different input text', () => {
    expect(() =>
      useCase.execute({
        documents: Array.from(
          { length: 8 },
          (_, index) =>
            ({
              ...document(String(index), [0.2, 0.3]),
              embeddingInputHash: `text-${index}`,
            }) as ReelIndexDocument,
        ),
        expectedDimensions: 2,
      }),
    ).toThrow(/duplicate ratio/);
  });
});
