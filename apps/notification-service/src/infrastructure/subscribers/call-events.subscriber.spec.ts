import type { RmqContext } from '@nestjs/microservices';

import { CallEventsSubscriber } from './call-events.subscriber';

const payload = {
  callId: 'call-1',
  conversationId: 'conversation-1',
  initiatorId: '11111111-1111-4111-8111-111111111111',
  targetUserId: '22222222-2222-4222-8222-222222222222',
  recipientUserId: '22222222-2222-4222-8222-222222222222',
  userId: '11111111-1111-4111-8111-111111111111',
  callType: 'VIDEO' as const,
  initiatorDisplayName: 'Quân Lê',
  ringTimeoutMs: 30_000,
  expiresAt: '2026-09-06T03:00:30.000Z',
  answerActionId: 'answer-action-1',
  lifecycleRevision: 4,
  at: '2026-09-06T03:00:00.000Z',
};

describe('CallEventsSubscriber', () => {
  let sendIncomingCallNotification: { execute: jest.Mock };
  let sendCallStateUpdate: { execute: jest.Mock };
  let subscriber: CallEventsSubscriber;
  let ack: jest.Mock;
  let nack: jest.Mock;

  beforeEach(() => {
    sendIncomingCallNotification = { execute: jest.fn().mockResolvedValue({}) };
    sendCallStateUpdate = { execute: jest.fn().mockResolvedValue({}) };
    subscriber = new CallEventsSubscriber(
      sendIncomingCallNotification as never,
      sendCallStateUpdate as never,
    );
    ack = jest.fn();
    nack = jest.fn();
  });

  const context = () =>
    ({
      getChannelRef: () => ({ ack, nack }),
      getMessage: () => ({
        fields: {},
        properties: {},
        content: Buffer.alloc(0),
      }),
    }) as unknown as RmqContext;

  it('persists an incoming-call notification before acknowledging the event', async () => {
    await subscriber.handleCallInitiated(payload, context());

    expect(sendIncomingCallNotification.execute).toHaveBeenCalledWith({
      recipientUserId: payload.recipientUserId,
      initiatorId: payload.initiatorId,
      targetUserId: payload.targetUserId,
      conversationId: payload.conversationId,
      callId: payload.callId,
      callType: 'VIDEO',
      initiatorDisplayName: payload.initiatorDisplayName,
      initiatorAvatarUrl: undefined,
      ringTimeoutMs: payload.ringTimeoutMs,
      expiresAt: payload.expiresAt,
    });
    expect(ack).toHaveBeenCalledTimes(1);
    expect(nack).not.toHaveBeenCalled();
  });

  it('routes an accepted answer to the winner-aware state update', async () => {
    await subscriber.handleCallAnswered(payload, context());

    expect(sendCallStateUpdate.execute).toHaveBeenCalledWith({
      recipientUserIds: [payload.initiatorId, payload.targetUserId],
      iosRecipientUserIds: [payload.targetUserId],
      conversationId: payload.conversationId,
      callId: payload.callId,
      status: 'active',
      reason: undefined,
      answerActionId: payload.answerActionId,
      lifecycleRevision: payload.lifecycleRevision,
      at: payload.at,
    });
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it('preserves terminal lifecycle meanings for native cleanup', async () => {
    await subscriber.handleCallEnded(
      { ...payload, reason: 'cancelled' },
      context(),
    );
    await subscriber.handleCallRejected(payload, context());

    expect(sendCallStateUpdate.execute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ status: 'cancelled', reason: 'cancelled' }),
    );
    expect(sendCallStateUpdate.execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ status: 'rejected' }),
    );
    expect(ack).toHaveBeenCalledTimes(2);
  });

  it('requeues a valid event when its durable notification handoff fails', async () => {
    sendCallStateUpdate.execute.mockRejectedValueOnce(
      new Error('database unavailable'),
    );

    await subscriber.handleCallEnded(payload, context());

    expect(ack).not.toHaveBeenCalled();
    expect(nack).toHaveBeenCalledWith(expect.anything(), false, true);
  });

  it('discards malformed lifecycle events instead of poisoning the queue', async () => {
    await subscriber.handleCallRejected(
      { callId: 'missing-fields' },
      context(),
    );

    expect(sendCallStateUpdate.execute).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
    expect(nack).toHaveBeenCalledWith(expect.anything(), false, false);
  });
});
