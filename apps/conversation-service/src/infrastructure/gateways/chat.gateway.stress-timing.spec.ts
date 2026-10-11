import { Logger } from '@nestjs/common';
import { of } from 'rxjs';
import { Socket } from 'socket.io';
import { Message } from '../../domain/entities/message.entity';
import { stressMessageTiming } from '../metrics/stress-message-timing';
import { ChatGateway } from './chat.gateway';

const namespace = 'mu-0123456789ab';
const uuid = '11111111-1111-4111-8111-111111111111';
const payload = {
  conversationId: '507f1f77bcf86cd799439011',
  clientMessageId: `${namespace}-${uuid}-load-${uuid}`,
  type: 'text' as const,
  signalType: 0,
  content: 'private content',
};

describe('Gateway stress trace trust and emission order', () => {
  afterEach(() => jest.restoreAllMocks());

  const harness = (email: string, created = true) => {
    const sequence: string[] = [];
    const metrics = {
      measurePhase: jest.fn((_phase: string, action: () => unknown) =>
        action(),
      ),
      recordMessageCreated: jest.fn(),
      recordSocketOutcome: jest.fn(),
      recordSendMessage: jest.fn(),
    };
    const message = new Message({
      ...payload,
      id: '507f1f77bcf86cd799439012',
      senderId: uuid,
      createdAt: new Date(),
    });
    const execute = jest.fn(() => {
      stressMessageTiming.mark('queued');
      stressMessageTiming.mark('transactionStarted');
      stressMessageTiming.mark('transactionResolved');
      return Promise.resolve({ message, created });
    });
    const auth = { send: jest.fn(() => of({ id: uuid, email, roles: [] })) };
    const repository = { findConversation: jest.fn().mockResolvedValue(null) };
    const gateway = new ChatGateway(
      { execute } as never,
      { execute: jest.fn().mockResolvedValue({}) } as never,
      metrics as never,
      repository as never,
      auth as never,
      {} as never,
    );
    const client = {
      id: 'test-socket',
      data: {},
      handshake: { auth: { token: 'private token' }, headers: {} },
      emit: jest.fn((event: string) => sequence.push(event)),
      to: jest.fn(() => ({
        emit: jest.fn((event: string) => sequence.push(event)),
      })),
      disconnect: jest.fn(),
    } as unknown as Socket;
    gateway.server = { to: jest.fn(() => ({ emit: jest.fn() })) } as never;
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation((value) => sequence.push(String(value)));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    return { gateway, client, sequence, log, execute, auth };
  };

  it('uses verified fixture email, records ACK then recipient submission, and emits no private content', async () => {
    const h = harness(`${namespace}.001@velora-stress.invalid`);
    await h.gateway.handleMessage(payload, h.client);
    expect(h.auth.send).toHaveBeenCalledWith('auth.verify_token', {
      token: 'private token',
    });
    expect(h.sequence.slice(0, 2)).toEqual(['message_synced', 'new_message']);
    const trace = JSON.parse(String(h.log.mock.calls[0][0])) as {
      outcome: string;
      elapsedMs: Record<string, number>;
    };
    expect(trace.outcome).toBe('ack_submitted');
    expect(Object.keys(trace.elapsedMs)).toEqual([
      'queued',
      'transactionStarted',
      'transactionResolved',
      'persistFinished',
      'ackSubmitted',
      'recipientsSubmitted',
    ]);
    expect(JSON.stringify(trace)).not.toMatch(/private content|private token/);
  });

  it('does not trace a regular account even with fixture-shaped message IDs', async () => {
    const h = harness('real@example.org');
    await h.gateway.handleMessage(payload, h.client);
    expect(h.log).not.toHaveBeenCalled();
    expect(h.sequence).toEqual(['message_synced', 'new_message']);
  });

  it('does not fan out idempotent retries and reports pre-ACK failures without inventing commit', async () => {
    const h = harness(`${namespace}.001@velora-stress.invalid`, false);
    await h.gateway.handleMessage(payload, h.client);
    expect(h.sequence[0]).toBe('message_synced');
    expect(h.client.to).not.toHaveBeenCalled();
    h.log.mockClear();
    h.execute.mockRejectedValueOnce(new Error('private error'));
    await h.gateway.handleMessage(payload, h.client);
    const trace = JSON.parse(String(h.log.mock.calls[0][0])) as {
      outcome: string;
      elapsedMs: Record<string, number>;
    };
    expect(trace).toMatchObject({ outcome: 'failed', elapsedMs: {} });
  });
});
