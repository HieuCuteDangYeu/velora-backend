import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import { safeCallErrorCode } from '../infrastructure/gateways/call-debug';
import { MediaNodeIdentity } from './media-node-identity';
import { MediaNodeModule } from './media-node.module';

export async function bootstrapMediaNode() {
  process.env.CALL_METRICS_SERVICE_NAME ??= 'call-media';
  const app = await NestFactory.create(MediaNodeModule);
  try {
    app.enableShutdownHooks();
    const identity = app.get(MediaNodeIdentity);
    // Only reachable inside the compose network; never publish this port.
    app.connectMicroservice({
      transport: Transport.TCP,
      options: { host: '0.0.0.0', port: identity.rpcPort },
    });
    await app.startAllMicroservices();
    await app.listen(identity.httpPort);
    console.log(
      `Call media node ${identity.nodeId} rpc=${identity.rpcPort} http=${identity.httpPort}`,
    );
  } catch (error) {
    await app.close();
    throw error;
  }
}

if (require.main === module) {
  void bootstrapMediaNode().catch((error) => {
    console.error(
      `Call media node failed to start errorCode=${safeCallErrorCode(error)}`,
    );
    process.exitCode = 1;
  });
}
