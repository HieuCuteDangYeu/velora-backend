import type { TranscriptSegment } from '@common/ai/interfaces/transcription-result.interface';

// Chunk evidence for foreign-language audio is the English translation followed
// by the Vietnamese translation of the same source segments.
export const VIETNAMESE_EVIDENCE_MARKER = ' Vietnamese: ';

const normalize = (value: string): string =>
  value.normalize('NFKC').replace(/\s+/g, ' ').trim();

// English and Vietnamese are already searchable by users, and Vietnamese audio
// is its own source, so only other source languages get a Vietnamese line.
export function segmentVietnamese(segment: TranscriptSegment): string {
  const language = segment.detectedLanguage?.toLowerCase();
  if (!language || language === 'en' || language === 'vi') return '';
  return typeof segment.textVi === 'string' ? normalize(segment.textVi) : '';
}

export function joinVietnamese(segments: TranscriptSegment[]): string {
  return normalize(segments.map(segmentVietnamese).filter(Boolean).join(' '));
}

export function appendVietnameseEvidence(
  evidenceText: string,
  vietnamese: string,
): string {
  return vietnamese
    ? `${evidenceText}${VIETNAMESE_EVIDENCE_MARKER}${vietnamese}`
    : evidenceText;
}

export function splitVietnameseEvidence(evidenceText: string): {
  primary: string;
  vietnamese?: string;
} {
  const index = evidenceText.indexOf(VIETNAMESE_EVIDENCE_MARKER);
  if (index < 0) return { primary: evidenceText };
  return {
    primary: evidenceText.slice(0, index),
    vietnamese: evidenceText.slice(index + VIETNAMESE_EVIDENCE_MARKER.length),
  };
}
