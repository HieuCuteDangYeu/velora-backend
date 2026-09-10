import { Test } from '@nestjs/testing';

import { ProcessNotificationJobUseCase } from './application/use-cases/process-notification-job.use-case';
import { RegisterPushTokenUseCase } from './application/use-cases/register-push-token.use-case';
import { ApnsVoipGateway } from './infrastructure/gateways/apns-voip.gateway';
import { FirebaseAdminGateway } from './infrastructure/gateways/firebase-admin.gateway';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import { NotificationServiceModule } from './notification-service.module';

describe('NotificationServiceModule', () => {
  it('composes application ports with infrastructure adapters', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [NotificationServiceModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider('REDIS_CLIENT')
      .useValue({})
      .overrideProvider(FirebaseAdminGateway)
      .useValue({ send: jest.fn() })
      .overrideProvider(ApnsVoipGateway)
      .useValue({ send: jest.fn() })
      .compile();

    expect(moduleRef.get(RegisterPushTokenUseCase)).toBeDefined();
    expect(moduleRef.get(ProcessNotificationJobUseCase)).toBeDefined();
    expect(moduleRef.get('IPushTokenRepository')).toBeDefined();
    expect(moduleRef.get('INotificationJobRepository')).toBeDefined();
    expect(moduleRef.get('IFcmPushGateway')).toBeDefined();
    expect(moduleRef.get('IApnsVoipGateway')).toBeDefined();

    await moduleRef.close();
  });
});
