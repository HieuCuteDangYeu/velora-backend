import type { GuardrailFinding } from './rag-guardrail.types';
import {
  INPUT_PATTERNS,
  matchGuardrailPatterns,
} from './rag-guardrail-patterns';
import {
  decodeBase64Candidates,
  normalizeForScreening,
} from './rag-guardrail-text';

const MAX_SCREENED_CHARS = 8_000;

/** Screens a raw user message for attempts to take control of the assistant. */
export function evaluateInputGuardrail(message: string): GuardrailFinding[] {
  const text = message.slice(0, MAX_SCREENED_CHARS);
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

  add(
    matchGuardrailPatterns(INPUT_PATTERNS, normalizeForScreening(text)),
    false,
  );

  // A payload hidden in base64 is always deliberate; a hit on its decoded form is high-confidence.
  for (const decoded of decodeBase64Candidates(text)) {
    add(
      matchGuardrailPatterns(INPUT_PATTERNS, normalizeForScreening(decoded)),
      true,
    );
  }

  return [...findings.values()];
}
