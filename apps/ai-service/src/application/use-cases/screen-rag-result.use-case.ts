import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import type { GuardrailEvidenceItem } from '@ai/domain/services/rag-guardrail/rag-evidence-guardrail';
import {
  readRagGuardrailModes,
  screenRagResult,
} from '@ai/domain/services/rag-guardrail/rag-guardrail';
import type { GuardrailFinding } from '@ai/domain/services/rag-guardrail/rag-guardrail.types';
import { Inject, Injectable, Optional } from '@nestjs/common';

/** Screens retrieved evidence and the finished answer. Findings are content-free codes. */
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
}
