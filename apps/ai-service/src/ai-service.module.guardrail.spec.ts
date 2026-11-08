import { BuildRagGuardrailSummaryUseCase } from '@ai/application/use-cases/build-rag-guardrail-summary.use-case';
import { ScreenRagInputUseCase } from '@ai/application/use-cases/screen-rag-input.use-case';
import { ScreenRagResultUseCase } from '@ai/application/use-cases/screen-rag-result.use-case';
import { AiServiceModule } from './ai-service.module';

// The workflow adapter takes these as @Optional(), so a missing registration
// would silently turn the guardrail off. This pins the module wiring.
describe('AiServiceModule guardrail wiring', () => {
  it('registers every guardrail use case as a provider', () => {
    const providers = Reflect.getMetadata(
      'providers',
      AiServiceModule,
    ) as unknown[];
    for (const useCase of [
      ScreenRagInputUseCase,
      ScreenRagResultUseCase,
      BuildRagGuardrailSummaryUseCase,
    ]) {
      expect(providers).toContain(useCase);
    }
  });
});
