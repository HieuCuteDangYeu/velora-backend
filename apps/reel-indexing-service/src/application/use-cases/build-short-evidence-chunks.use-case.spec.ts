import type { IIndexingApplicationConfig } from '@indexing/domain/interfaces/indexing-application-config.interface';
import { createHash } from 'crypto';
import { BuildShortEvidenceChunksUseCase } from './build-short-evidence-chunks.use-case';
import { ValidateEvidenceIndexCandidateUseCase } from './validate-evidence-index-candidate.use-case';

const applicationConfig = (
  config: Record<string, string>,
): IIndexingApplicationConfig => ({
  get: <T = string>(key: string) => config[key] as T | undefined,
  transcriptionIdentity: () => ({
    provider: 'groq',
    model: 'whisper-large-v3-turbo',
    version: 'groq-whisper-v3-turbo-v1',
  }),
  embeddingIdentity: () => ({
    model: config['AI_EMBEDDING_MODEL'] || 'BAAI/bge-m3',
    dimensions: Number(config['AI_EMBEDDING_DIMENSIONS'] || 1024),
    version: config['AI_EMBEDDING_VERSION'] || 'bge-m3-tei-v1',
  }),
});

const makeBuilder = (config: Record<string, string>) =>
  new BuildShortEvidenceChunksUseCase(applicationConfig(config));

const segment = (start: number, end: number, text: string, id: string) => ({
  start,
  end,
  text,
  sourceSegmentId: id,
});

const normalize = (value: string) =>
  value.normalize('NFKC').replace(/\s+/g, ' ').trim();

describe('BuildShortEvidenceChunksUseCase', () => {
  const baseConfig = {
    INDEX_SHORT_CHUNK_MAX_TOKENS: '50',
    INDEX_SHORT_CHUNK_TARGET_TOKENS: '40',
    INDEX_SHORT_CHUNK_MIN_TOKENS: '10',
    INDEX_SHORT_CHUNK_OVERLAP_TOKENS: '2',
    INDEX_SHORT_CHUNK_MAX_SECONDS: '45',
    INDEX_CHUNK_LARGE_PAUSE_MS: '1500',
  };

  it('keeps a small tail after a large pause contiguous when merging it', () => {
    const source = [
      segment(
        0,
        4,
        'one two three four five six seven eight nine ten eleven twelve.',
        'a',
      ),
      segment(6, 7, 'thirteen fourteen fifteen.', 'b'),
    ];

    const chunks = makeBuilder(baseConfig).execute(source);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      evidenceText:
        'one two three four five six seven eight nine ten eleven twelve. thirteen fourteen fifteen.',
      sourceSegmentIds: ['a', 'b'],
      endTime: 7,
    });
    expect(normalize(source.map((item) => item.text).join(' '))).toContain(
      normalize(chunks[0].evidenceText),
    );
  });

  it('retains a final post-pause tail smaller than the overlap', () => {
    const source = [
      segment(
        0,
        4,
        'one two three four five six seven eight nine ten eleven twelve.',
        'a',
      ),
      segment(6, 7, 'thirteen.', 'b'),
    ];

    const chunks = makeBuilder(baseConfig).execute(source);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      evidenceText:
        'one two three four five six seven eight nine ten eleven twelve. thirteen.',
      sourceSegmentIds: ['a', 'b'],
      endTime: 7,
    });
  });

  it('removes only real leading overlap when merging a normal overlapped tail', () => {
    const source = [
      segment(0, 1, 'one two three four five.', 'a'),
      segment(1, 2, 'six seven eight.', 'b'),
    ];
    const chunks = makeBuilder({
      ...baseConfig,
      INDEX_SHORT_CHUNK_TARGET_TOKENS: '5',
    }).execute(source);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].evidenceText).toBe(
      'one two three four five. six seven eight.',
    );
    expect(normalize(source.map((item) => item.text).join(' '))).toContain(
      normalize(chunks[0].evidenceText),
    );
  });

  it('keeps a small tail separate when appending its true unique tokens exceeds the maximum', () => {
    const source = [
      segment(
        0,
        4,
        'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen.',
        'a',
      ),
      segment(
        6,
        7,
        'twenty twenty-one twenty-two twenty-three twenty-four.',
        'b',
      ),
    ];
    const chunks = makeBuilder({
      ...baseConfig,
      INDEX_SHORT_CHUNK_MAX_TOKENS: '20',
    }).execute(source);

    expect(chunks).toHaveLength(2);
    expect(
      chunks.every((chunk) =>
        normalize(source.map((item) => item.text).join(' ')).includes(
          normalize(chunk.evidenceText),
        ),
      ),
    ).toBe(true);
  });

  it('uses the same provenance-aware merge behavior for long chunks', () => {
    const source = [
      segment(
        0,
        4,
        'one two three four five six seven eight nine ten eleven twelve.',
        'a',
      ),
      segment(6, 7, 'thirteen fourteen fifteen.', 'b'),
    ];
    const chunks = makeBuilder({
      ...baseConfig,
      INDEX_LONG_CHUNK_MAX_TOKENS: '50',
      INDEX_LONG_CHUNK_TARGET_TOKENS: '40',
      INDEX_LONG_CHUNK_MIN_TOKENS: '10',
      INDEX_LONG_CHUNK_OVERLAP_TOKENS: '2',
      INDEX_LONG_CHUNK_MAX_SECONDS: '45',
    }).execute(source, 'INDEX_LONG_CHUNK');

    expect(chunks).toHaveLength(1);
    expect(normalize(source.map((item) => item.text).join(' '))).toContain(
      normalize(chunks[0].evidenceText),
    );
  });

  it('passes the production candidate-grounding invariant after a large-pause tail merge', () => {
    const source = [
      segment(
        0,
        4,
        'one two three four five six seven eight nine ten eleven twelve.',
        'a',
      ),
      segment(6, 7, 'thirteen fourteen fifteen.', 'b'),
    ];
    const config = { ...baseConfig, AI_EMBEDDING_DIMENSIONS: '1024' };
    const chunks = makeBuilder(config).execute(source);
    const hash = (value: string) =>
      createHash('sha256').update(value.normalize('NFKC')).digest('hex');
    const document = (
      id: string,
      kind: 'REEL' | 'CHUNK',
      ordinal: number,
      evidenceText?: string,
    ) => ({
      id,
      reelId: 'reel-1',
      parentId: kind === 'CHUNK' ? 'reel-1' : undefined,
      kind,
      ordinal,
      evidenceText,
      retrievalText: evidenceText || 'reel metadata',
      sourceSectionIds: [],
      sourceSegmentIds:
        kind === 'CHUNK'
          ? chunks[ordinal].sourceSegmentIds
          : source.map((item) => item.sourceSegmentId),
      sourceAudioArtifactIds: [],
      evidenceHash: evidenceText ? hash(evidenceText) : undefined,
      retrievalHash: hash(evidenceText || 'reel metadata'),
      evidenceQuality: 'VERIFIED' as const,
      transcriptVersion: '1',
      sectioningVersion: '1',
      chunkingVersion: '1',
      summaryVersion: '1',
      indexVersion: '1',
      embeddingProvider: 'self-hosted-tei',
      embeddingModel: 'BAAI/bge-m3',
      embeddingDimensions: 1024,
      embeddingVersion: 'bge-m3-tei-v1',
      embeddingInputHash: 'input',
      embedding: Array(1024).fill(0.1),
      tokenCount: 1,
      ...(kind === 'CHUNK'
        ? {
            startTime: chunks[ordinal].startTime,
            endTime: chunks[ordinal].endTime,
          }
        : {}),
    });

    expect(() =>
      new ValidateEvidenceIndexCandidateUseCase(
        applicationConfig(config),
      ).execute({
        job: {
          reelId: 'reel-1',
          sourceLengthClass: 'SHORT',
          sourceDurationMs: 7_000,
        } as never,
        documents: [
          document('reel-1', 'REEL', 0),
          ...chunks.map((chunk, ordinal) =>
            document(`chunk-${ordinal}`, 'CHUNK', ordinal, chunk.evidenceText),
          ),
        ],
        transcriptSegments: source,
      }),
    ).not.toThrow();
  });
});
