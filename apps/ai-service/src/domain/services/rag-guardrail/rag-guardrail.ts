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
import { evaluateMemoryGuardrail } from './rag-memory-guardrail';
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
  memory: GuardrailMode;
  /** Model-based second opinion on the input. Off unless explicitly turned on: it costs a model call. */
  classifier: GuardrailMode;
}

function parseMode(raw: unknown): GuardrailMode | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().toLowerCase();
  if (value === 'off') return 'off';
  if (value === 'shadow') return 'shadow';
  if (value === 'enforce') return 'enforce';
  return undefined;
}

/**
 * AI_GUARDRAIL_MODE sets the default (off | shadow | enforce, default shadow);
 * AI_GUARDRAIL_{INPUT,EVIDENCE,OUTPUT,MEMORY}_MODE override one check. The
 * classifier is the exception: it defaults to off whatever the default is,
 * because it makes a model call per screened message.
 */
export function readRagGuardrailModes(
  config?: RagGuardrailConfig,
): RagGuardrailModes {
  const fallback = parseMode(config?.get('AI_GUARDRAIL_MODE')) ?? 'shadow';
  const read = (key: string) => parseMode(config?.get(key)) ?? fallback;
  return {
    input: read('AI_GUARDRAIL_INPUT_MODE'),
    evidence: read('AI_GUARDRAIL_EVIDENCE_MODE'),
    output: read('AI_GUARDRAIL_OUTPUT_MODE'),
    memory: read('AI_GUARDRAIL_MEMORY_MODE'),
    classifier: parseMode(config?.get('AI_GUARDRAIL_CLASSIFIER_MODE')) ?? 'off',
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

/** True when the output check enforces and the finished answer has a high-severity finding. */
export function shouldBlockRagOutput(
  findings: readonly GuardrailFinding[],
  modes: RagGuardrailModes,
): boolean {
  return (
    modes.output === 'enforce' &&
    findings.some(
      (finding) => finding.check === 'output' && finding.severity === 'high',
    )
  );
}

/**
 * Splits retrieved evidence into what may reach the prompt and what may not.
 * Only when the evidence check enforces is a chunk with a high-severity finding
 * dropped; otherwise everything is kept and the caller screens as usual.
 */
export function filterEvidenceForPrompt<T extends GuardrailEvidenceItem>(
  items: readonly T[],
  modes: RagGuardrailModes,
): { kept: T[]; findings: GuardrailFinding[] } {
  if (modes.evidence !== 'enforce') return { kept: [...items], findings: [] };
  const kept: T[] = [];
  const findings: GuardrailFinding[] = [];
  items.forEach((item, index) => {
    const itemFindings = evaluateEvidenceGuardrail([item]);
    if (itemFindings.some((finding) => finding.severity === 'high')) {
      findings.push(...itemFindings.map((finding) => ({ ...finding, index })));
    } else {
      kept.push(item);
    }
  });
  return { kept, findings };
}

/** True when the memory check enforces and some text to be stored has a high-severity finding. */
export function shouldBlockRagMemory(
  findings: readonly GuardrailFinding[],
  modes: RagGuardrailModes,
): boolean {
  return (
    modes.memory === 'enforce' &&
    findings.some(
      (finding) => finding.check === 'memory' && finding.severity === 'high',
    )
  );
}

export function screenRagMemory(
  text: string,
  modes: RagGuardrailModes,
): GuardrailFinding[] {
  return modes.memory === 'off' ? [] : evaluateMemoryGuardrail(text);
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
  const all = [
    modes.input,
    modes.evidence,
    modes.output,
    modes.memory,
    modes.classifier,
  ];
  const mode: GuardrailMode = all.includes('enforce')
    ? 'enforce'
    : all.every((value) => value === 'off')
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
    memoryCodes: codesFor('memory'),
    classifierCodes: codesFor('classifier'),
  };
}
