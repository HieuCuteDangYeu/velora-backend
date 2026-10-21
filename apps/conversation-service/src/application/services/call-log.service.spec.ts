import type { CallLoggedEvent } from '@common/calls/call-history.types';

import { CallLogController } from '../../infrastructure/controllers/call-log.controller';
import { buildCallLogContent, CallLogService } from './call-log.service';

const event: CallLoggedEvent = {
  callId: 'call-1',
  conversationId: 'conversation-1',
  callType: 'VOICE',
  isGroupCall: false,
  initiatorId: 'caller',
  outcome: 'COMPLETED',
  terminalReason: 'ended',
  durationSec: 192,
  startedAt: '2026-10-22T10:00:00.000Z',
  endedAt: '2026-10-22T10:03:22.000Z',
  participants: [
    { userId: 'caller', role: 'CALLER', result: 'ANSWERED' },
    { userId: 'callee', role: 'CALLEE', result: 'ANSWERED' },
  ],
};

const setup = (created = true) => {
  const conversation = {
    id: 'conversation-1',
    creatorId: 'owner',
    participantIds: ['caller', 'callee'],
  };
  const chatRepository = {
    findConversation: jest.fn().mockResolvedValue(conversation),
    createMessageIdempotently: jest.fn((message: { id?: string }) =>
      Promise.resolve({ created, message: { ...message, id: 'message-1' } }),
    ),
  };
  const realtimePublisher = {
    emitNewMessage: jest.fn(),
    emitConversationUpdated: jest.fn(),
  };
  const service = new CallLogService(
    chatRepository as never,
    realtimePublisher,
  );
  return { service, chatRepository, realtimePublisher, conversation };
};

describe('CallLogService', () => {
  it('adds one idempotent call row from the caller and broadcasts it', async () => {
    const { service, chatRepository, realtimePublisher } = setup();

    await expect(service.record(event)).resolves.toBe(true);

    const [message, options] =
      chatRepository.createMessageIdempotently.mock.calls[0];
    expect(options).toBeUndefined();
    expect(message).toMatchObject({
      conversationId: 'conversation-1',
      senderId: 'caller',
      clientMessageId: 'call:call-1',
      signalType: 0,
      type: 'text',
      content: 'Voice call · 3:12',
      metadata: {
        kind: 'call_log',
        callLog: {
          callId: 'call-1',
          callType: 'VOICE',
          isGroupCall: false,
          initiatorId: 'caller',
          outcome: 'COMPLETED',
          terminalReason: 'ended',
          durationSec: 192,
          participants: event.participants,
        },
      },
    });
    expect(realtimePublisher.emitNewMessage).toHaveBeenCalledWith(
      'conversation-1',
      expect.objectContaining({ id: 'message-1' }),
    );
    expect(realtimePublisher.emitConversationUpdated).toHaveBeenCalledTimes(1);
  });

  it('does not broadcast a replayed event again', async () => {
    const { service, realtimePublisher } = setup(false);

    await expect(service.record(event)).resolves.toBe(true);

    expect(realtimePublisher.emitNewMessage).not.toHaveBeenCalled();
  });

  it('writes the row as the group creator when the caller has left', async () => {
    const { service, chatRepository, conversation } = setup();
    conversation.participantIds = ['owner', 'callee'];

    await service.record({ ...event, isGroupCall: true });

    expect(
      chatRepository.createMessageIdempotently.mock.calls[0][0],
    ).toMatchObject({ senderId: 'owner' });
  });

  it('skips a conversation that no longer exists', async () => {
    const { service, chatRepository } = setup();
    chatRepository.findConversation.mockResolvedValue(null);

    await expect(service.record(event)).resolves.toBe(false);
    expect(chatRepository.createMessageIdempotently).not.toHaveBeenCalled();
  });
});

describe('buildCallLogContent', () => {
  it.each([
    [{ outcome: 'COMPLETED', durationSec: 3725 }, 'Voice call · 1:02:05'],
    [{ outcome: 'MISSED', durationSec: undefined }, 'Missed voice call'],
    [
      { outcome: 'DECLINED', callType: 'VIDEO', durationSec: undefined },
      'Declined video call',
    ],
    [{ outcome: 'FAILED', durationSec: undefined }, 'Voice call failed'],
    [
      { outcome: 'MISSED', isGroupCall: true, durationSec: undefined },
      'Missed group voice call',
    ],
    [
      { outcome: 'COMPLETED', isGroupCall: true, durationSec: 59 },
      'Group voice call · 0:59',
    ],
  ] as const)('%o → %s', (overrides, expected) => {
    expect(buildCallLogContent({ ...event, ...overrides })).toBe(expected);
  });
});

describe('CallLogController', () => {
  it('drops a malformed event without touching the chat', async () => {
    const record = jest.fn();
    const controller = new CallLogController({ record } as never);

    await controller.handleCallLogged({ callId: 'call-1' });

    expect(record).not.toHaveBeenCalled();
  });

  it('records a valid event and never throws back to the broker', async () => {
    const record = jest.fn().mockRejectedValue(new Error('mongo down'));
    const controller = new CallLogController({ record } as never);

    await expect(controller.handleCallLogged(event)).resolves.toBeUndefined();
    expect(record).toHaveBeenCalledWith(event);
  });
});
