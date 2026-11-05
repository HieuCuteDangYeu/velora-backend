import { INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { Server, ServerOptions } from 'socket.io';

export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor: (nsp: any) => any;

  constructor(
    private app: INestApplicationContext,
    private configService: ConfigService,
  ) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    const host = this.configService.get<string>('REDIS_HOST');
    const port = this.configService.get<number>('REDIS_PORT');
    const password = this.configService.get<string>('REDIS_PASSWORD');

    let url = `redis://${host}:${port}`;
    if (password) {
      url = `redis://:${password}@${host}:${port}`;
    }

    if (host?.includes('upstash')) {
      url = `rediss://:${password}@${host}:${port}`;
    }

    const pubClient = new Redis(url);
    const subClient = pubClient.duplicate();

    await Promise.all([
      pubClient.ping().catch((err) => console.error('Redis Pub Error', err)),
      subClient.ping().catch((err) => console.error('Redis Sub Error', err)),
    ]);

    this.adapterConstructor = createAdapter(pubClient, subClient);
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options) as Server;

    server.adapter(this.adapterConstructor);

    return server;
  }
}
