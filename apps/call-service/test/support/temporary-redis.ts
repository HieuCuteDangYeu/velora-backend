import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Redis from 'ioredis';

export const redisServerAvailable =
  spawnSync('redis-server', ['--version']).status === 0;

export interface TemporaryRedis {
  socket: string;
  client(): Promise<Redis>;
  stop(): Promise<void>;
}

/** Starts a throwaway redis-server on a Unix socket (no persistence). */
export async function startTemporaryRedis(): Promise<TemporaryRedis> {
  // Unix socket paths are short on macOS; os.tmpdir() can exceed that limit.
  const directory = mkdtempSync('/tmp/velora-call-redis-');
  const socket = join(directory, 'redis.sock');
  const server: ChildProcess = spawn(
    'redis-server',
    ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'],
    { stdio: 'ignore' },
  );
  for (let attempt = 0; attempt < 100 && !existsSync(socket); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!existsSync(socket)) throw new Error('Temporary Redis did not start');

  const clients: Redis[] = [];
  return {
    socket,
    async client() {
      const redis = new Redis({
        path: socket,
        lazyConnect: true,
        retryStrategy: () => 20,
      });
      await redis.connect();
      clients.push(redis);
      return redis;
    },
    async stop() {
      for (const redis of clients) redis.disconnect();
      if (server.exitCode === null && server.signalCode === null) {
        server.kill();
        await once(server, 'exit');
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
