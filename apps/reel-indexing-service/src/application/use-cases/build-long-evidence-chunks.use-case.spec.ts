import type { TranscriptSegment } from '@common/ai/interfaces/transcription-result.interface';
import type { TranscriptSection } from '@indexing/domain/entities/index-checkpoint.entity';
import type { IIndexingApplicationConfig } from '@indexing/domain/interfaces/indexing-application-config.interface';
import { BuildLongEvidenceChunksUseCase } from './build-long-evidence-chunks.use-case';
import { BuildShortEvidenceChunksUseCase } from './build-short-evidence-chunks.use-case';

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
    model: 'BAAI/bge-m3',
    dimensions: 1024,
    version: 'bge-m3-tei-v1',
  }),
});

const builder = () =>
  new BuildLongEvidenceChunksUseCase(
    new BuildShortEvidenceChunksUseCase(
      applicationConfig({
        INDEX_LONG_CHUNK_MAX_TOKENS: '60',
        INDEX_LONG_CHUNK_TARGET_TOKENS: '40',
        INDEX_LONG_CHUNK_MIN_TOKENS: '1',
        INDEX_LONG_CHUNK_OVERLAP_TOKENS: '0',
        INDEX_LONG_CHUNK_MAX_SECONDS: '45',
      }),
    ),
  );

const segment = (
  start: number,
  end: number,
  id: string,
  text = 'alpha bravo charlie delta echo foxtrot',
): TranscriptSegment => ({ start, end, text, sourceSegmentId: id });

const section = (
  index: number,
  startMs: number,
  endMs: number,
): TranscriptSection => ({ index, startMs, endMs, text: `section ${index}` });

describe('BuildLongEvidenceChunksUseCase', () => {
  // Real shape from reel 8f588df3 (2026-11-18): the merged transcript is not strictly in time
  // order, so section 1 ended at 599.083 s while section 2 started at 598.880 s. A segment from
  // 598.9 s to 599.18 s was given to BOTH sections and its chunk ended 97 ms past section 1, which
  // the index validation rejects ("Chunk ... is outside its parent section").
  const sections = [
    section(0, 300, 300_480),
    section(1, 298_943, 599_083),
    section(2, 598_880, 899_160),
  ];
  const segments = [
    segment(10, 20, 's-a'),
    segment(298.95, 299.4, 's-b'),
    segment(560.44, 598.7, 's-c'),
    segment(598.9, 599.18, 's-straddle'),
    segment(600, 610, 's-d'),
  ];

  it('keeps every chunk inside its parent section, to within a millisecond', () => {
    const chunks = builder().execute(sections, segments);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      const parent = sections.find((s) => s.index === chunk.sectionIndex)!;
      expect(chunk.startTime).toBeGreaterThanOrEqual(
        parent.startMs / 1000 - 0.001,
      );
      expect(chunk.endTime).toBeLessThanOrEqual(parent.endMs / 1000 + 0.001);
    }
  });

  it('gives each segment to exactly one section and covers all of them', () => {
    const chunks = builder().execute(sections, segments);
    const owners = new Map<string, number[]>();
    for (const chunk of chunks) {
      for (const id of chunk.sourceSegmentIds) {
        owners.set(id, [...(owners.get(id) ?? []), chunk.sectionIndex]);
      }
    }
    for (const s of segments) {
      const sectionsOfSegment = [
        ...new Set(owners.get(s.sourceSegmentId as string)),
      ];
      expect(sectionsOfSegment).toHaveLength(1);
    }
    // the segment that starts inside the overlap belongs to the later section
    expect(owners.get('s-straddle')).toEqual(expect.arrayContaining([2]));
    expect(owners.get('s-straddle')).not.toContain(1);
  });

  it('still assigns a segment that starts before the first section or after the last one', () => {
    const chunks = builder().execute(sections, [
      segment(0.1, 0.25, 'early'),
      segment(899.5, 900.2, 'late'),
    ]);
    const ids = chunks.flatMap((chunk) => chunk.sourceSegmentIds);
    expect(ids).toEqual(expect.arrayContaining(['early', 'late']));
    for (const chunk of chunks) {
      const parent = sections.find((s) => s.index === chunk.sectionIndex)!;
      expect(chunk.startTime).toBeGreaterThanOrEqual(
        parent.startMs / 1000 - 0.001,
      );
      expect(chunk.endTime).toBeLessThanOrEqual(parent.endMs / 1000 + 0.001);
    }
  });

  it('leaves non-overlapping sections exactly as before', () => {
    const plain = [section(0, 0, 10_000), section(1, 10_000, 20_000)];
    const chunks = builder().execute(plain, [
      segment(1, 2, 'p1'),
      segment(11, 12, 'p2'),
    ]);
    expect(chunks.map((c) => [c.sectionIndex, c.sourceSegmentIds])).toEqual([
      [0, ['p1']],
      [1, ['p2']],
    ]);
  });
});
