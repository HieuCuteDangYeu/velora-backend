import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import {
  readRagGuardrailModes,
  summarizeGuardrail,
} from '@ai/domain/services/rag-guardrail/rag-guardrail';
import type {
  GuardrailFinding,
  RagGuardrailSummary,
} from '@ai/domain/services/rag-guardrail/rag-guardrail.types';
import { Inject, Injectable, Optional } from '@nestjs/common';

/** Reduces findings to a content-free summary that is safe to log and attach to traces. */
@Injectable()
export class BuildRagGuardrailSummaryUseCase {
  constructor(
    @Optional()
    @Inject('IAiApplicationConfig')
    private readonly config?: IAiApplicationConfig,
  ) {}

  execute(findings: readonly GuardrailFinding[]): RagGuardrailSummary {
    return summarizeGuardrail(findings, readRagGuardrailModes(this.config));
  }
}
