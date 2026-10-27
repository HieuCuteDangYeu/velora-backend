import {
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

import { StressRunsResponseSchema } from './stress-runs-response';

@Injectable()
export class StressRunsService {
  private readonly origin =
    process.platform === 'darwin'
      ? 'http://127.0.0.1:18944'
      : 'http://host.docker.internal:18944';

  async request(
    method: 'GET' | 'POST',
    path: string,
    token: string,
    body?: unknown,
  ): Promise<unknown> {
    try {
      const response = await fetch(`${this.origin}${path}`, {
        method,
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) {
        if (response.status === 409)
          throw new HttpException(
            'Another run is active, or cleanup is still pending',
            409,
          );
        if (response.status === 400)
          throw new HttpException(
            'Stress agent rejected the test configuration',
            400,
          );
        throw new ServiceUnavailableException(
          'Stress agent is unavailable or not authorized',
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Empty response');
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 512_000) {
          await reader.cancel();
          throw new Error('Oversized response');
        }
        chunks.push(value);
      }
      return StressRunsResponseSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      // Never forward host paths, upstream errors or fixture credentials to the browser.
      throw new ServiceUnavailableException(
        'Stress agent is offline. Start it on the server before running a test',
      );
    }
  }
}
