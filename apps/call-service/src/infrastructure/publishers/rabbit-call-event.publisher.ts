import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { CallDeclineTokenService } from '@common/calls/call-decline-token.service';
import {
  CallLifecycleEvent,
  CallLifecyclePayload,
  ICallEventPublisher,
} from '../../domain/interfaces/call-event.publisher.interface';

@Injectable()
export class RabbitCallEventPublisher implements ICallEventPublisher {
  constructor(
    @Inject('NOTIFICATION_SERVICE_RMQ') private readonly client: ClientProxy,
    private readonly declineTokenService: CallDeclineTokenService,
  ) {}

  async publish(
    event: CallLifecycleEvent,
    payload: CallLifecyclePayload,
  ): Promise<void> {
    // Bound every lifecycle publisher caller so a stalled broker cannot
    // monopolize a cleanup/outbox batch. Durable events remain retryable.
    await firstValueFrom(
      this.client
        .emit(event, this.withDeclineToken(event, payload))
        .pipe(timeout(5000)),
    );
  }

  // Every invitation (1:1, first group ring, group re-invite) is published
  // here, so this is the one place that mints the recipient's decline token.
  private withDeclineToken(
    event: CallLifecycleEvent,
    payload: CallLifecyclePayload,
  ): CallLifecyclePayload {
    if (event !== 'call.initiated') return payload;
    return {
      ...payload,
      declineToken: this.declineTokenService.issue({
        callId: payload.callId,
        userId: payload.recipientUserId,
        ...(payload.isGroupCall
          ? { invitationId: payload.invitationId ?? payload.callId }
          : {}),
        ringExpiresAt: new Date(payload.expiresAt),
      }),
    };
  }
}
