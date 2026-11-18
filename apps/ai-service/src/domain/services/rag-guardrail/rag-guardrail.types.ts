export type GuardrailCheckName =
  | 'input'
  | 'evidence'
  | 'output'
  | 'memory'
  | 'classifier';

/**
 * - `high`: a payload or leak with no benign reading; would be blocked or
 *   redacted once enforcement exists.
 * - `medium`: suspicious but plausible in normal use; recorded only.
 */
export type GuardrailSeverity = 'medium' | 'high';

/**
 * `shadow` records what a check would have done and never changes behaviour.
 * `enforce` acts on a high-severity finding: the input check refuses the
 * request, the evidence check drops the chunk before the prompt, the output
 * check replaces the answer, the memory check refuses to store the text and
 * the classifier refuses a message it judges an attack.
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
  codes: string[];
  inputCodes: string[];
  evidenceCodes: string[];
  outputCodes: string[];
  memoryCodes: string[];
  classifierCodes: string[];
}
