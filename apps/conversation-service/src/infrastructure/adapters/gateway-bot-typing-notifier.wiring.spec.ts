import { Test } from '@nestjs/testing';
import { TriggerBotReplyUseCase } from '../../application/use-cases/trigger-bot-reply.use-case';
import { ChatGateway } from '../gateways/chat.gateway';
import { PresenceRegistry } from '../gateways/presence-registry';
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
      .useMocker((token) => (token === PresenceRegistry ? undefined : {}))
      .compile();

    expect(moduleRef.get(ChatGateway)).toBeInstanceOf(ChatGateway);
    expect(moduleRef.get('IBotTypingNotifier')).toBeInstanceOf(
      GatewayBotTypingNotifierAdapter,
    );
    await moduleRef.close();
  }, 15_000);

  it('injects the presence registry into the gateway', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ChatGateway,
        TriggerBotReplyUseCase,
        {
          provide: 'IBotTypingNotifier',
          useClass: GatewayBotTypingNotifierAdapter,
        },
        {
          provide: PresenceRegistry,
          inject: ['REDIS_CLIENT'],
          useFactory: (redis: never) => new PresenceRegistry(redis),
        },
        { provide: 'REDIS_CLIENT', useValue: {} },
      ],
    })
      .useMocker(() => ({}))
      .compile();

    const gateway = moduleRef.get(ChatGateway);
    expect(gateway['presence']).toBeInstanceOf(PresenceRegistry);
    await moduleRef.close();
  }, 15_000);
});
