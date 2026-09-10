import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';

jest.mock('@nestjs/core', () => ({
  NestFactory: { create: jest.fn() },
}));

jest.mock('../../../src/call-service.module', () => ({
  CallServiceModule: class CallServiceModule {},
}));

import { bootstrap } from '../../../src/main';

describe('call-service bootstrap', () => {
  it('owns the runtime lease before starting the call.get_state RMQ listener', async () => {
    const order: string[] = [];
    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'RABBITMQ_URL') return 'amqp://rabbitmq:5672';
        if (key === 'FRONTEND_URL') return 'https://velora-app.me';
        if (key === 'CALL_PORT') return 3007;
        return undefined;
      }),
    };
    const runtimeLease = {
      onLeaseLost: jest.fn(),
      acquire: jest.fn(() => {
        order.push('lease');
      }),
    };
    const restartRecovery = {
      execute: jest.fn(() => {
        order.push('recovery');
      }),
    };
    const app = {
      get: jest
        .fn()
        .mockReturnValueOnce(configService)
        .mockReturnValueOnce(runtimeLease)
        .mockReturnValueOnce(restartRecovery),
      connectMicroservice: jest.fn(() => {
        order.push('rmq');
      }),
      enableCors: jest.fn(),
      startAllMicroservices: jest.fn(() => {
        order.push('start');
      }),
      listen: jest.fn(() => {
        order.push('listen');
      }),
      close: jest.fn(() => undefined),
    };
    (NestFactory.create as jest.Mock).mockResolvedValue(app);

    await bootstrap();

    expect(app.connectMicroservice).toHaveBeenCalledWith({
      transport: Transport.RMQ,
      options: {
        urls: ['amqp://rabbitmq:5672'],
        queue: 'call_queue',
        queueOptions: { durable: true },
      },
    });
    expect(app.startAllMicroservices).toHaveBeenCalledTimes(1);
    expect(app.listen).toHaveBeenCalledWith(3007);
    expect(restartRecovery.execute).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['lease', 'recovery', 'rmq', 'start', 'listen']);
  });

  it('fails closed before opening any listener when the runtime lease is unavailable', async () => {
    const leaseError = new Error('lease is already held');
    const runtimeLease = {
      onLeaseLost: jest.fn(),
      acquire: jest.fn().mockRejectedValue(leaseError),
    };
    const app = {
      get: jest
        .fn()
        .mockReturnValueOnce({ get: jest.fn() })
        .mockReturnValueOnce(runtimeLease),
      connectMicroservice: jest.fn(),
      enableCors: jest.fn(),
      startAllMicroservices: jest.fn(),
      listen: jest.fn(),
      close: jest.fn(() => undefined),
    };
    (NestFactory.create as jest.Mock).mockResolvedValue(app);

    await expect(bootstrap()).rejects.toThrow(leaseError);

    expect(app.connectMicroservice).not.toHaveBeenCalled();
    expect(app.startAllMicroservices).not.toHaveBeenCalled();
    expect(app.listen).not.toHaveBeenCalled();
    expect(app.close).toHaveBeenCalledTimes(1);
  });

  it('fails closed before opening any listener when active media recovery fails', async () => {
    const recoveryError = new Error('active call recovery failed');
    const runtimeLease = {
      onLeaseLost: jest.fn(),
      acquire: jest.fn(() => undefined),
    };
    const restartRecovery = {
      execute: jest.fn().mockRejectedValue(recoveryError),
    };
    const app = {
      get: jest
        .fn()
        .mockReturnValueOnce({ get: jest.fn() })
        .mockReturnValueOnce(runtimeLease)
        .mockReturnValueOnce(restartRecovery),
      connectMicroservice: jest.fn(),
      enableCors: jest.fn(),
      startAllMicroservices: jest.fn(),
      listen: jest.fn(),
      close: jest.fn(() => undefined),
    };
    (NestFactory.create as jest.Mock).mockResolvedValue(app);

    await expect(bootstrap()).rejects.toThrow(recoveryError);

    expect(restartRecovery.execute).toHaveBeenCalledTimes(1);
    expect(app.connectMicroservice).not.toHaveBeenCalled();
    expect(app.startAllMicroservices).not.toHaveBeenCalled();
    expect(app.listen).not.toHaveBeenCalled();
    expect(app.close).toHaveBeenCalledTimes(1);
  });

  it('does not expose HTTP when the RMQ listener cannot start', async () => {
    const startError = new Error('RabbitMQ unavailable');
    const runtimeLease = {
      onLeaseLost: jest.fn(),
      acquire: jest.fn(() => undefined),
    };
    const restartRecovery = {
      execute: jest.fn(() => undefined),
    };
    const app = {
      get: jest
        .fn()
        .mockReturnValueOnce({ get: jest.fn() })
        .mockReturnValueOnce(runtimeLease)
        .mockReturnValueOnce(restartRecovery),
      connectMicroservice: jest.fn(),
      enableCors: jest.fn(),
      startAllMicroservices: jest.fn().mockRejectedValue(startError),
      listen: jest.fn(),
      close: jest.fn(() => undefined),
    };
    (NestFactory.create as jest.Mock).mockResolvedValue(app);

    await expect(bootstrap()).rejects.toThrow(startError);

    expect(app.connectMicroservice).toHaveBeenCalledTimes(1);
    expect(app.listen).not.toHaveBeenCalled();
    expect(app.close).toHaveBeenCalledTimes(1);
  });
});
