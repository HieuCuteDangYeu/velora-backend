import type { TranscriptSegment } from '@common/ai/interfaces/transcription-result.interface';
import { BuildShortEvidenceChunksUseCase } from '@indexing/application/use-cases/build-short-evidence-chunks.use-case';
import type { EvidenceChunk } from '@indexing/domain/entities/evidence-chunk.entity';
import type { TranscriptSection } from '@indexing/domain/entities/index-checkpoint.entity';
import { Injectable } from '@nestjs/common';

export interface SectionEvidenceChunk extends EvidenceChunk {
  sectionIndex: number;
}

@Injectable()
export class BuildLongEvidenceChunksUseCase {
  constructor(private readonly buildChunks: BuildShortEvidenceChunksUseCase) {}

  /**
   * Every segment goes to exactly ONE section: the last section that starts at or before the
   * segment (a segment before the first section goes to the first one). The old rule, "start inside
   * [section.startMs, section.endMs)", gave a segment to every section whose window contained its
   * start. Sections are cut from a merged transcript that is not strictly in time order, so
   * neighbouring sections can overlap by a fraction of a second; a segment from that overlap was
   * indexed twice and its chunk could end after its section did, which the index validation
   * rejects ("Chunk ... is outside its parent section", reel 8f588df3, 2026-11-18). Chunk times are
   * also fitted into the section as a last guard, so the invariant holds whatever the segments are.
   */
  execute(
    sections: TranscriptSection[],
    segments: TranscriptSegment[],
  ): SectionEvidenceChunk[] {
    if (sections.length === 0) return [];
    const byStart = [...sections].sort(
      (left, right) => left.startMs - right.startMs || left.index - right.index,
    );
    const owned = new Map<number, TranscriptSegment[]>(
      sections.map((section) => [section.index, []]),
    );
    for (const segment of segments) {
      const startMs = segment.start * 1000;
      let owner = byStart[0];
      for (const candidate of byStart) {
        if (candidate.startMs > startMs) break;
        owner = candidate;
      }
      owned.get(owner.index)?.push(segment);
    }

    return sections.flatMap((section) =>
      this.buildChunks
        .execute(owned.get(section.index) ?? [], 'INDEX_LONG_CHUNK')
        .map((chunk) => ({
          ...chunk,
          ...this.fitInto(section, chunk.startTime, chunk.endTime),
          sectionIndex: section.index,
        })),
    );
  }

  private fitInto(
    section: TranscriptSection,
    startTime: number,
    endTime: number,
  ): { startTime: number; endTime: number } {
    const lower = section.startMs / 1000;
    const upper = section.endMs / 1000;
    return {
      startTime: Math.min(Math.max(startTime, lower), upper),
      endTime: Math.max(Math.min(endTime, upper), lower),
    };
  }
}
