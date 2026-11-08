export type GuardrailCheckName = 'input' | 'evidence' | 'output';

/**
 * - `high`: a payload or leak with no benign reading; would be blocked or
 *   redacted once enforcement exists.
 * - `medium`: suspicious but plausible in normal use; recorded only.
 */
export type GuardrailSeverity = 'medium' | 'high';

/**
 * `shadow` records what a check would have done and never changes behaviour.
 * Enforcement (blocking, neutralising, redacting) is a later phase.
 */
export type GuardrailMode = 'off' | 'shadow';

export interface GuardrailFinding {
  check: GuardrailCheckName;
  /** Stable, content-free identifier such as INSTRUCTION_OVERRIDE. */
  code: string;
  severity: GuardrailSeverity;
  /** The match needed de-obfuscation (zero-width, homoglyphs, leetspeak, base64). */
  obfuscated?: boolean;
  /** Evidence finding: zero-based index of the offending evidence item. */
  index?: number;
}

export interface RagGuardrailSummary {
  mode: GuardrailMode;
  findingCount: number;
  wouldBlock: boolean;
  codes: string[];
  inputCodes: string[];
  evidenceCodes: string[];
  outputCodes: string[];
}
