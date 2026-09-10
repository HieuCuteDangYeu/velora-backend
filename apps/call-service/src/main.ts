import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import { RecoverActiveCallsAfterMediaRestartUseCase } from './application/use-cases/recover-active-calls-after-media-restart.use-case';
import { CallServiceModule } from './call-service.module';
import { CallServiceRuntimeLease } from './infrastructure/runtime/call-service-runtime-lease.service';

export async function bootstrap() {
  const app = await NestFactory.create(CallServiceModule);
  try {
    const configService = app.get(ConfigService);
    const runtimeLease = app.get(CallServiceRuntimeLease);

    runtimeLease.onLeaseLost(async (error) => {
      console.error(
        `Call runtime lease lost; stopping service: ${error.message}`,
      );
      await app.close();
      // A closed Nest listener is not enough to guarantee that Mediasoup or
      // another native handle will release Node's event loop. Exit after the
      // graceful close so Docker cannot keep a lease-less call runtime alive.
      process.exit(1);
    });
    await runtimeLease.acquire();

    // An outbox worker can publish call.answered as soon as Nest lifecycle
    // hooks start. Reconcile process-local Mediasoup state before attaching
    // any listener so a restarted service never publishes an obsolete active
    // call immediately before its required terminal transition.
    const restartRecovery = app.get(RecoverActiveCallsAfterMediaRestartUseCase);
    await restartRecovery.execute();

    // The REST endpoint used by a cold-start resume proxies this RPC to
    // `call_queue`. Keep the listener alive, but only after this process owns
    // the single-runtime lease so a second Mediasoup process cannot serve it.
    app.connectMicroservice({
      transport: Transport.RMQ,
      options: {
        urls: [
          configService.get<string>('RABBITMQ_URL') || 'amqp://localhost:5672',
        ],
        queue: 'call_queue',
        queueOptions: { durable: true },
      },
    });

    app.enableCors({
      origin: configService.get<string>('FRONTEND_URL'),
      credentials: true,
    });

    await app.startAllMicroservices();

    const port = configService.get<number>('CALL_PORT') || 3007;
    await app.listen(port);

    console.log(`Call service is running on: http://localhost:${port}/api`);
  } catch (error) {
    await app.close();
    throw error;
  }
}

if (require.main === module) {
  void bootstrap().catch((error) => {
    console.error(
      `Call service failed to start: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  });
}
