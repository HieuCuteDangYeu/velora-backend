export type GuardrailCheckName = 'input' | 'evidence' | 'output';

/**
 * - `high`: a payload or leak with no benign reading; would be blocked or
 *   redacted once enforcement exists.
 * - `medium`: suspicious but plausible in normal use; recorded only.
 */
export type GuardrailSeverity = 'medium' | 'high';

/**
 * `shadow` records what a check would have done and never changes behaviour.
 * `enforce` is supported for the input check only: a high-severity finding
 * makes the request return a fixed refusal. Evidence and output checks stay
 * shadow until they have their own replay gate.
 */
export type GuardrailMode = 'off' | 'shadow' | 'enforce';

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
  /** The input check is enforcing and refused this request. */
  blocked: boolean;
  codes: string[];
  inputCodes: string[];
  evidenceCodes: string[];
  outputCodes: string[];
}
