import { Test } from '@nestjs/testing';
import { TriggerBotReplyUseCase } from '../../application/use-cases/trigger-bot-reply.use-case';
import { ChatGateway } from '../gateways/chat.gateway';
import { GatewayBotTypingNotifierAdapter } from './gateway-bot-typing-notifier.adapter';

// Regression: the gateway needs the use case, the use case needs the notifier
// and the notifier used to need the gateway. Nest never resolved that loop, so
// the service booted without error but never started consuming messages, and
// unit tests with hand-built instances could not see it.
describe('bot typing notifier wiring', () => {
  it('resolves ChatGateway, the use case and the notifier together', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ChatGateway,
        TriggerBotReplyUseCase,
        {
          provide: 'IBotTypingNotifier',
          useClass: GatewayBotTypingNotifierAdapter,
        },
      ],
    })
      .useMocker(() => ({}))
      .compile();

    expect(moduleRef.get(ChatGateway)).toBeInstanceOf(ChatGateway);
    expect(moduleRef.get('IBotTypingNotifier')).toBeInstanceOf(
      GatewayBotTypingNotifierAdapter,
    );
    await moduleRef.close();
  }, 15_000);
});
