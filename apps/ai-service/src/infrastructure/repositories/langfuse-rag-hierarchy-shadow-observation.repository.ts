import type {
  IRagHierarchyShadowObservationRepository,
  RagHierarchyShadowObservation,
} from '@ai/domain/interfaces/rag-hierarchy-shadow-observation.repository.interface';
import { LangfuseTracingService } from '@ai/infrastructure/services/langfuse-tracing.service';
import { Injectable } from '@nestjs/common';

@Injectable()
export class LangfuseRagHierarchyShadowObservationRepository implements IRagHierarchyShadowObservationRepository {
  constructor(private readonly tracing: LangfuseTracingService) {}

  save(observation: RagHierarchyShadowObservation): Promise<void> {
    this.tracing.recordHierarchyShadow(observation);
    return Promise.resolve();
  }
}
