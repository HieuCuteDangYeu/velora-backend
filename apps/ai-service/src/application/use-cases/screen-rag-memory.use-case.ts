import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import {
  readRagGuardrailModes,
  screenRagMemory,
  shouldBlockRagMemory,
} from '@ai/domain/services/rag-guardrail/rag-guardrail';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

/**
 * Decides whether text may be stored as long-term memory or a conversation summary.
 * Stored text returns in later prompts as trusted background, so an attack that was
 * merely answered once must not be able to persist. In shadow mode it only logs
 * codes; a failure here fails open, since the guardrail must not break memory.
 */
@Injectable()
export class ScreenRagMemoryUseCase {
  private readonly logger = new Logger(ScreenRagMemoryUseCase.name);

  constructor(
    @Optional()
    @Inject('IAiApplicationConfig')
    private readonly config?: IAiApplicationConfig,
  ) {}

  /** True when the memory check enforces and some text has a high-severity finding. */
  blocks(texts: readonly string[], source: 'memory' | 'summary'): boolean {
    try {
      const modes = readRagGuardrailModes(this.config);
      if (modes.memory === 'off') return false;

      const findings = texts.flatMap((text) => screenRagMemory(text, modes));
      if (findings.length === 0) return false;

      const blocked = shouldBlockRagMemory(findings, modes);
      const wouldBlock = findings.some(
        (finding) => finding.severity === 'high',
      );
      const codes = [...new Set(findings.map((finding) => finding.code))];
      const line = `[Guardrail] check=memory source=${source} mode=${modes.memory} wouldBlock=${wouldBlock} blocked=${blocked} memory=${codes.join(',')}`;
      if (wouldBlock) this.logger.warn(line);
      else this.logger.log(line);
      return blocked;
    } catch (error: unknown) {
      this.logger.warn(
        `Guardrail memory screening failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}
