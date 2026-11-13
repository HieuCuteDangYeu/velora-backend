import { BOT_USER_ID } from '@common/constants/seed.constants';
import { ChatGateway } from '../gateways/chat.gateway';
import { GatewayBotTypingNotifierAdapter } from './gateway-bot-typing-notifier.adapter';

const CONVERSATION_ID = '507f1f77bcf86cd799439011';
const typing = (isTyping: boolean) => [
  CONVERSATION_ID,
  'user_typing',
  { conversationId: CONVERSATION_ID, userId: BOT_USER_ID, isTyping },
];

describe('GatewayBotTypingNotifierAdapter', () => {
  let emitToConversation: jest.Mock;
  let adapter: GatewayBotTypingNotifierAdapter;

  beforeEach(() => {
    jest.useFakeTimers();
    emitToConversation = jest.fn();
    adapter = new GatewayBotTypingNotifierAdapter({
      emitToConversation,
    } as unknown as ChatGateway);
  });

  afterEach(() => {
    adapter.onModuleDestroy();
    jest.useRealTimers();
  });

  it('announces typing as the bot and keeps refreshing it for long turns', () => {
    adapter.start(CONVERSATION_ID);
    expect(emitToConversation).toHaveBeenCalledTimes(1);
    expect(emitToConversation).toHaveBeenLastCalledWith(...typing(true));

    jest.advanceTimersByTime(9_000);
    expect(emitToConversation).toHaveBeenCalledTimes(4);
  });

  it('does not double-start a conversation that is already typing', () => {
    adapter.start(CONVERSATION_ID);
    adapter.start(CONVERSATION_ID);
    expect(emitToConversation).toHaveBeenCalledTimes(1);
  });

  it('stops the heartbeat and announces the end exactly once', () => {
    adapter.start(CONVERSATION_ID);
    adapter.stop(CONVERSATION_ID);
    adapter.stop(CONVERSATION_ID);

    expect(emitToConversation).toHaveBeenLastCalledWith(...typing(false));
    expect(emitToConversation).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(30_000);
    expect(emitToConversation).toHaveBeenCalledTimes(2);
  });

  it('does nothing when stopping a conversation that never started', () => {
    adapter.stop(CONVERSATION_ID);
    expect(emitToConversation).not.toHaveBeenCalled();
  });

  it('gives up on a turn that never reports back', () => {
    adapter.start(CONVERSATION_ID);
    jest.advanceTimersByTime(120_000);

    expect(emitToConversation).toHaveBeenLastCalledWith(...typing(false));
    const calls = emitToConversation.mock.calls.length;
    jest.advanceTimersByTime(30_000);
    expect(emitToConversation).toHaveBeenCalledTimes(calls);
  });

  it('never throws into the AI turn when the socket layer fails', () => {
    emitToConversation.mockImplementation(() => {
      throw new Error('socket down');
    });
    expect(() => adapter.start(CONVERSATION_ID)).not.toThrow();
    expect(() => adapter.stop(CONVERSATION_ID)).not.toThrow();
  });
});
