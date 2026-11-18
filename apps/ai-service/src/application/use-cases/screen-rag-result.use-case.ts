import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import type { GuardrailEvidenceItem } from '@ai/domain/services/rag-guardrail/rag-evidence-guardrail';
import { evaluateOutputGuardrail } from '@ai/domain/services/rag-guardrail/rag-output-guardrail';
import {
  filterEvidenceForPrompt,
  readRagGuardrailModes,
  screenRagResult,
  shouldBlockRagOutput,
} from '@ai/domain/services/rag-guardrail/rag-guardrail';
import type { GuardrailFinding } from '@ai/domain/services/rag-guardrail/rag-guardrail.types';
import { Inject, Injectable, Optional } from '@nestjs/common';

/** What the user sees when the output check stops an answer. It says nothing about why. */
export const RAG_OUTPUT_REFUSAL_MESSAGE =
  'I can’t share that answer. Ask me about a Reel or another question and I’ll do my best.';

/**
 * Screens retrieved evidence and the finished answer. Findings are content-free codes.
 * In shadow mode this only reports; when the evidence or output check enforces, the
 * caller uses `filterEvidence` and `blocksAnswer` to act on a high-severity finding.
 */
@Injectable()
export class ScreenRagResultUseCase {
  constructor(
    @Optional()
    @Inject('IAiApplicationConfig')
    private readonly config?: IAiApplicationConfig,
  ) {}

  execute(input: {
    answer: string;
    userMessage: string;
    citations: ReadonlyArray<{ reelId: string }>;
    accessibleReelIds: readonly string[];
    evidence: readonly GuardrailEvidenceItem[];
  }): GuardrailFinding[] {
    return screenRagResult(input, readRagGuardrailModes(this.config));
  }

  /**
   * Chunks that may reach the prompt. With the evidence check enforcing, a chunk
   * with a high-severity finding is dropped and reported; otherwise nothing changes.
   */
  filterEvidence<T extends GuardrailEvidenceItem>(
    items: readonly T[],
  ): { kept: T[]; findings: GuardrailFinding[] } {
    return filterEvidenceForPrompt(items, readRagGuardrailModes(this.config));
  }

  /** True when the output check enforces and the answer has a high-severity finding. */
  blocksAnswer(findings: readonly GuardrailFinding[]): boolean {
    return shouldBlockRagOutput(findings, readRagGuardrailModes(this.config));
  }

  /** True when the output check enforces, so streaming must hold text back until it is screened. */
  enforcesOutput(): boolean {
    return readRagGuardrailModes(this.config).output === 'enforce';
  }

  /**
   * Screens answer text on its own (no citations), for use while the answer is
   * still being published. Returns the content-free codes of a blocking finding.
   */
  blockingAnswerCodes(input: {
    answer: string;
    userMessage: string;
    accessibleReelIds: readonly string[];
  }): string[] {
    const modes = readRagGuardrailModes(this.config);
    if (modes.output !== 'enforce') return [];
    const findings = evaluateOutputGuardrail({ ...input, citations: [] });
    return shouldBlockRagOutput(findings, modes)
      ? [...new Set(findings.map((finding) => finding.code))]
      : [];
  }
}
