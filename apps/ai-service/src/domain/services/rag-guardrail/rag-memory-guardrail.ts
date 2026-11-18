import type { GuardrailFinding } from './rag-guardrail.types';
import {
  MEMORY_PATTERNS,
  matchGuardrailPatterns,
} from './rag-guardrail-patterns';
import {
  decodeEncodedCandidates,
  normalizeForScreening,
} from './rag-guardrail-text';

const MAX_SCREENED_CHARS = 8_000;

/**
 * Screens text about to be stored as long-term memory or a conversation summary.
 * Stored text comes back into later prompts as trusted background, so an attack
 * that was answered once must not be able to persist.
 */
export function evaluateMemoryGuardrail(text: string): GuardrailFinding[] {
  const findings = new Map<string, GuardrailFinding>();
  const screened = text.slice(0, MAX_SCREENED_CHARS);
  const add = (candidate: string, obfuscatedSource: boolean) => {
    for (const hit of matchGuardrailPatterns(
      MEMORY_PATTERNS,
      normalizeForScreening(candidate),
    )) {
      const existing = findings.get(hit.code);
      if (
        existing &&
        !(hit.severity === 'high' && existing.severity !== 'high')
      ) {
        continue;
      }
      findings.set(hit.code, {
        check: 'memory',
        code: hit.code,
        severity: hit.severity,
        ...(hit.obfuscated || obfuscatedSource ? { obfuscated: true } : {}),
      });
    }
  };

  add(screened, false);
  for (const decoded of decodeEncodedCandidates(screened)) add(decoded, true);
  return [...findings.values()];
}
