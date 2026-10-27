import { ConfigService } from '@nestjs/config';
import { of } from 'rxjs';
import { CallDeclineTokenService } from '@common/calls/call-decline-token.service';
import type { CallLifecyclePayload } from '../../../src/domain/interfaces/call-event.publisher.interface';
import { RabbitCallEventPublisher } from '../../../src/infrastructure/publishers/rabbit-call-event.publisher';

const tokens = new CallDeclineTokenService({
  get: () => 'test-secret',
} as unknown as ConfigService);

const payload = (overrides: Partial<CallLifecyclePayload> = {}) =>
  ({
    callId: 'room-1',
    conversationId: 'conversation-1',
    initiatorId: 'caller',
    targetUserId: 'callee',
    recipientUserId: 'callee',
    userId: 'caller',
    callType: 'VOICE',
    initiatorDisplayName: 'Caller',
    ringTimeoutMs: 30_000,
    expiresAt: '2026-10-24T10:00:30.000Z',
    at: '2026-10-24T10:00:00.000Z',
    ...overrides,
  }) as CallLifecyclePayload;

const setup = () => {
  const emit = jest.fn().mockReturnValue(of(undefined));
  const publisher = new RabbitCallEventPublisher({ emit } as never, tokens);
  const emitted = () => emit.mock.calls[0][1] as CallLifecyclePayload;
  return { publisher, emit, emitted };
};

describe('RabbitCallEventPublisher decline token', () => {
  it('lets a 1:1 callee decline only that call', async () => {
    const { publisher, emitted } = setup();
    await publisher.publish('call.initiated', payload());

    const verified = tokens.verify(emitted().declineToken ?? '', 0);
    expect(verified).toMatchObject({ callId: 'room-1', userId: 'callee' });
    expect(verified?.invitationId).toBeUndefined();
  });

  it('binds a group ring to the invitation, falling back to the room id', async () => {
    const { publisher, emitted } = setup();
    await publisher.publish(
      'call.initiated',
      payload({ isGroupCall: true, invitationId: 'invite-9' }),
    );
    expect(tokens.verify(emitted().declineToken ?? '', 0)).toMatchObject({
      callId: 'room-1',
      userId: 'callee',
      invitationId: 'invite-9',
    });

    const first = setup();
    await first.publisher.publish(
      'call.initiated',
      payload({ isGroupCall: true }),
    );
    expect(
      tokens.verify(first.emitted().declineToken ?? '', 0)?.invitationId,
    ).toBe('room-1');
  });

  it('issues no token on terminal events', async () => {
    for (const event of [
      'call.answered',
      'call.ended',
      'call.rejected',
    ] as const) {
      const { publisher, emitted } = setup();
      await publisher.publish(event, payload());
      expect(emitted().declineToken).toBeUndefined();
    }
  });
});
