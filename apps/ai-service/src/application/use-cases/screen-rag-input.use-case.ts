import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import {
  readRagGuardrailModes,
  screenRagInput,
  shouldBlockRagInput,
} from '@ai/domain/services/rag-guardrail/rag-guardrail';
import type { GuardrailFinding } from '@ai/domain/services/rag-guardrail/rag-guardrail.types';
import { Inject, Injectable, Optional } from '@nestjs/common';

/** Screens a raw user message. Findings are content-free codes; only `blocks` can change what happens next. */
@Injectable()
export class ScreenRagInputUseCase {
  constructor(
    @Optional()
    @Inject('IAiApplicationConfig')
    private readonly config?: IAiApplicationConfig,
  ) {}

  execute(input: { message: string }): GuardrailFinding[] {
    return screenRagInput(input.message, readRagGuardrailModes(this.config));
  }

  /** Whether these findings make the input check refuse the request (enforce mode only). */
  blocks(findings: readonly GuardrailFinding[]): boolean {
    return shouldBlockRagInput(findings, readRagGuardrailModes(this.config));
  }
}
