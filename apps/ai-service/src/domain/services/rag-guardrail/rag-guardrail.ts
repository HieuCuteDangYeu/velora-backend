import type {
  GuardrailFinding,
  GuardrailMode,
  RagGuardrailSummary,
} from './rag-guardrail.types';
import {
  evaluateEvidenceGuardrail,
  type GuardrailEvidenceItem,
} from './rag-evidence-guardrail';
import { evaluateInputGuardrail } from './rag-input-guardrail';
import {
  evaluateOutputGuardrail,
  type OutputGuardrailInput,
} from './rag-output-guardrail';

export interface RagGuardrailConfig {
  get<T = string>(key: string): T | undefined;
}

export interface RagGuardrailModes {
  input: GuardrailMode;
  evidence: GuardrailMode;
  output: GuardrailMode;
}

function parseMode(raw: unknown): GuardrailMode | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().toLowerCase();
  if (value === 'off') return 'off';
  if (value === 'shadow') return 'shadow';
  if (value === 'enforce') return 'enforce';
  return undefined;
}

/** Only the input check can enforce; anywhere else `enforce` is recorded as shadow. */
const withoutEnforce = (mode: GuardrailMode): GuardrailMode =>
  mode === 'enforce' ? 'shadow' : mode;

/**
 * AI_GUARDRAIL_MODE sets the default (off | shadow | enforce, default shadow);
 * AI_GUARDRAIL_{INPUT,EVIDENCE,OUTPUT}_MODE override one check. `enforce` only
 * takes effect for the input check.
 */
export function readRagGuardrailModes(
  config?: RagGuardrailConfig,
): RagGuardrailModes {
  const fallback = parseMode(config?.get('AI_GUARDRAIL_MODE')) ?? 'shadow';
  const read = (key: string) => parseMode(config?.get(key)) ?? fallback;
  return {
    input: read('AI_GUARDRAIL_INPUT_MODE'),
    evidence: withoutEnforce(read('AI_GUARDRAIL_EVIDENCE_MODE')),
    output: withoutEnforce(read('AI_GUARDRAIL_OUTPUT_MODE')),
  };
}

/** True when the input check enforces and found something with no benign reading. */
export function shouldBlockRagInput(
  findings: readonly GuardrailFinding[],
  modes: RagGuardrailModes,
): boolean {
  return (
    modes.input === 'enforce' &&
    findings.some(
      (finding) => finding.check === 'input' && finding.severity === 'high',
    )
  );
}

export function screenRagInput(
  message: string,
  modes: RagGuardrailModes,
): GuardrailFinding[] {
  return modes.input === 'off' ? [] : evaluateInputGuardrail(message);
}

export function screenRagResult(
  input: OutputGuardrailInput & {
    evidence: readonly GuardrailEvidenceItem[];
  },
  modes: RagGuardrailModes,
): GuardrailFinding[] {
  return [
    ...(modes.evidence === 'off'
      ? []
      : evaluateEvidenceGuardrail(input.evidence)),
    ...(modes.output === 'off' ? [] : evaluateOutputGuardrail(input)),
  ];
}

/** Content-free summary that is safe to log and attach to traces. */
export function summarizeGuardrail(
  findings: readonly GuardrailFinding[],
  modes: RagGuardrailModes,
): RagGuardrailSummary {
  const codesFor = (check: GuardrailFinding['check']) => [
    ...new Set(
      findings
        .filter((finding) => finding.check === check)
        .map((finding) => finding.code),
    ),
  ];
  const mode: GuardrailMode =
    modes.input === 'enforce'
      ? 'enforce'
      : modes.input === 'off' &&
          modes.evidence === 'off' &&
          modes.output === 'off'
        ? 'off'
        : 'shadow';
  return {
    mode,
    findingCount: findings.length,
    wouldBlock: findings.some((finding) => finding.severity === 'high'),
    codes: [...new Set(findings.map((finding) => finding.code))],
    inputCodes: codesFor('input'),
    evidenceCodes: codesFor('evidence'),
    outputCodes: codesFor('output'),
  };
}
