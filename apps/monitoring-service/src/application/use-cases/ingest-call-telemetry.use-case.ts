import type { CallTelemetryEventPayload } from '@common/calls/dtos/call-telemetry.dto';
import { Inject, Injectable } from '@nestjs/common';
import type { ICallTelemetryRepository } from '../../domain/interfaces/call-telemetry.repository.interface';
import type { ICallTelemetryTokenVerifier } from '../../domain/interfaces/call-telemetry-token-verifier.interface';
import type {
  StoredCallTelemetryEvent,
  TelemetryJsonObject,
} from '../../domain/models/call-telemetry.model';

@Injectable()
export class IngestCallTelemetryUseCase {
  constructor(
    @Inject('ICallTelemetryRepository')
    private readonly repository: ICallTelemetryRepository,
    @Inject('ICallTelemetryTokenVerifier')
    private readonly tokenVerifier: ICallTelemetryTokenVerifier,
  ) {}

  async execute(events: CallTelemetryEventPayload[]) {
    const storedEvents: StoredCallTelemetryEvent[] = [];
    let rejected = 0;

    for (const event of events) {
      const storedEvent = this.toStoredEvent(event);
      if (storedEvent) {
        storedEvents.push(storedEvent);
      } else {
        rejected += 1;
      }
    }

    const accepted =
      storedEvents.length > 0 ? await this.repository.create(storedEvents) : 0;

    return { accepted, rejected };
  }

  private toStoredEvent(
    event: CallTelemetryEventPayload,
  ): StoredCallTelemetryEvent | null {
    const token = event.telemetryToken
      ? this.tokenVerifier.verify(event.telemetryToken)
      : null;

    if (event.telemetryToken && !token) {
      return null;
    }

    const metricsJson: TelemetryJsonObject | null =
      event.metrics || event.details
        ? {
            ...event.metrics,
            ...(event.details ? { details: event.details } : {}),
          }
        : null;

    return {
      eventId: event.eventId,
      attemptId: event.attemptId,
      callId: token?.callId ?? null,
      role: token?.role ?? null,
      eventType: event.eventType,
      stage: event.stage,
      outcome: event.outcome ?? null,
      elapsedMs: Math.round(event.elapsedMs),
      occurredAt: new Date(event.occurredAt),
      platform: event.platform,
      appVersion: event.appVersion,
      osVersion: event.osVersion ?? null,
      direction: token
        ? token.role === 'host'
          ? 'outgoing'
          : 'incoming'
        : (event.direction ?? null),
      errorCode: event.errorCode ?? null,
      metricsJson,
    };
  }
}
