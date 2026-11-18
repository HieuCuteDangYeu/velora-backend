import type { GuardrailFinding } from './rag-guardrail.types';
import {
  INPUT_PATTERNS,
  matchGuardrailPatterns,
} from './rag-guardrail-patterns';
import {
  decodeEncodedCandidates,
  normalizeForScreening,
} from './rag-guardrail-text';

const MAX_SCREENED_CHARS = 8_000;

/**
 * Both ends of a long message are screened: the prompt keeps the start and the
 * end of an oversized message, so a payload placed after the first 8,000
 * characters must not slip past the check.
 */
function screenedWindows(message: string): string[] {
  if (message.length <= MAX_SCREENED_CHARS) return [message];
  return [
    message.slice(0, MAX_SCREENED_CHARS),
    message.slice(-MAX_SCREENED_CHARS),
  ];
}

/** Screens a raw user message for attempts to take control of the assistant. */
export function evaluateInputGuardrail(message: string): GuardrailFinding[] {
  const findings = new Map<string, GuardrailFinding>();
  const add = (
    hits: ReturnType<typeof matchGuardrailPatterns>,
    forceObfuscated: boolean,
  ) => {
    for (const hit of hits) {
      const existing = findings.get(hit.code);
      const finding: GuardrailFinding = {
        check: 'input',
        code: hit.code,
        severity: hit.severity,
        ...(hit.obfuscated || forceObfuscated ? { obfuscated: true } : {}),
      };
      if (
        !existing ||
        (finding.severity === 'high' && existing.severity !== 'high')
      ) {
        findings.set(hit.code, finding);
      }
    }
  };

  for (const text of screenedWindows(message)) {
    add(
      matchGuardrailPatterns(INPUT_PATTERNS, normalizeForScreening(text)),
      false,
    );

    // A payload hidden in an encoding (base64, hex, escapes, ROT13, reversed) is always deliberate.
    for (const decoded of decodeEncodedCandidates(text)) {
      add(
        matchGuardrailPatterns(INPUT_PATTERNS, normalizeForScreening(decoded)),
        true,
      );
    }
  }

  return [...findings.values()];
}
