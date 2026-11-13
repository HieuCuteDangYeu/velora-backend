import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import {
  readRagGuardrailModes,
  screenRagInput,
  shouldBlockRagInput,
} from '@ai/domain/services/rag-guardrail/rag-guardrail';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

/** What the user sees when the input check refuses. It says nothing about why. */
export const RAG_INPUT_REFUSAL_MESSAGE =
  'I can’t help with that request. Ask me about a Reel or another question and I’ll do my best.';

export interface RagInputRefusal {
  refuse: boolean;
  /** Content-free finding codes, safe to log. */
  codes: string[];
}

/**
 * Decides whether the input check, when it enforces, turns a message away.
 * In shadow or off mode it does no work and never refuses. A failure here
 * fails open: the guardrail must not be able to take chat down.
 */
@Injectable()
export class RefuseRagInputUseCase {
  private readonly logger = new Logger(RefuseRagInputUseCase.name);

  constructor(
    @Optional()
    @Inject('IAiApplicationConfig')
    private readonly config?: IAiApplicationConfig,
  ) {}

  execute(input: { message: string }): RagInputRefusal {
    try {
      const modes = readRagGuardrailModes(this.config);
      if (modes.input !== 'enforce') return { refuse: false, codes: [] };

      const findings = screenRagInput(input.message, modes);
      return {
        refuse: shouldBlockRagInput(findings, modes),
        codes: [...new Set(findings.map((finding) => finding.code))],
      };
    } catch (error: unknown) {
      this.logger.warn(
        `Guardrail input refusal check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { refuse: false, codes: [] };
    }
  }
}
