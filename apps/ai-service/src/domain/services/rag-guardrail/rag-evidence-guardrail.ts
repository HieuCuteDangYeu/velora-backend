import type { GuardrailFinding } from './rag-guardrail.types';
import {
  EVIDENCE_PATTERNS,
  matchGuardrailPatterns,
} from './rag-guardrail-patterns';
import { normalizeForScreening } from './rag-guardrail-text';

export interface GuardrailEvidenceItem {
  evidenceText?: string;
  chunkText?: string;
  title?: string;
  description?: string;
  tags?: string[];
}

const MAX_ITEMS = 32;
const MAX_FIELD_CHARS = 4_000;

/**
 * Screens retrieved reel evidence (transcript, OCR text, metadata) for text that
 * addresses the assistant. Reels are user-supplied, so this is the main
 * indirect-injection surface.
 */
export function evaluateEvidenceGuardrail(
  items: readonly GuardrailEvidenceItem[],
): GuardrailFinding[] {
  const findings: GuardrailFinding[] = [];
  items.slice(0, MAX_ITEMS).forEach((item, index) => {
    const combined = [
      item.evidenceText ?? item.chunkText,
      item.title,
      item.description,
      item.tags?.join(' '),
    ]
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.slice(0, MAX_FIELD_CHARS))
      .join('\n');
    if (!combined) return;

    for (const hit of matchGuardrailPatterns(
      EVIDENCE_PATTERNS,
      normalizeForScreening(combined),
    )) {
      findings.push({
        check: 'evidence',
        code: hit.code,
        severity: hit.severity,
        index,
        ...(hit.obfuscated ? { obfuscated: true } : {}),
      });
    }
  });
  return findings;
}
