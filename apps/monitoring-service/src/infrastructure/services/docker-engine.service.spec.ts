import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { DockerEngineService } from './docker-engine.service';

describe('DockerEngineService', () => {
  const config = new ConfigService({
    DOCKER_ENGINE_SOCKET: '/var/run/docker.sock',
    DOCKER_ENGINE_TIMEOUT_MS: '1000',
  });

  it('maps Docker API stats to service resources', async () => {
    const service = new DockerEngineService(config);
    const requestJson = jest.spyOn(service as any, 'requestJson');
    requestJson.mockImplementation((path: string) => {
      if (path === '/containers/json?all=false&size=true') {
        return Promise.resolve([
          {
            Id: 'container-id',
            Names: ['/velora-api-gateway-1'],
            Labels: { 'com.docker.compose.service': 'api-gateway' },
            SizeRw: 4096,
          },
        ]);
      }

      if (path.includes('/stats?stream=false')) {
        return Promise.resolve({
          cpu_stats: {
            cpu_usage: { total_usage: 3_000_000 },
            system_cpu_usage: 20_000_000,
            online_cpus: 4,
          },
          precpu_stats: {
            cpu_usage: { total_usage: 1_000_000 },
            system_cpu_usage: 10_000_000,
          },
          memory_stats: {
            usage: 1000,
            stats: { inactive_file: 200 },
          },
        });
      }

      if (path.includes('/json?size=true')) {
        return Promise.resolve({ HostConfig: { Memory: 4096 } });
      }

      return Promise.reject(new Error(`Unexpected Docker API path: ${path}`));
    });

    await expect(service.snapshot()).resolves.toEqual([
      {
        service: 'api-gateway',
        container: 'velora-api-gateway-1',
        cpuCores: 0.8,
        memoryWorkingSetBytes: 800,
        memoryLimitBytes: 4096,
        filesystemUsageBytes: 4096,
      },
    ]);
  });

  it('reads host CPU capacity and shared Docker storage for breakdowns', async () => {
    const service = new DockerEngineService(config);
    const requestJson = jest.spyOn(service as any, 'requestJson');
    requestJson.mockImplementation((path: string) => {
      if (path === '/info') return Promise.resolve({ NCPU: 8 });
      if (path === '/system/df') {
        return Promise.resolve({
          LayersSize: 1024,
          Volumes: [{ UsageData: { Size: 200 } }, { UsageData: { Size: 300 } }],
          BuildCache: [{ Size: 50 }, { Size: 25 }],
        });
      }
      return Promise.reject(new Error(`Unexpected Docker API path: ${path}`));
    });

    await expect(service.snapshotMetadata()).resolves.toEqual({
      hostCpuCount: 8,
      storage: {
        imagesBytes: 1024,
        volumesBytes: 500,
        buildCacheBytes: 75,
      },
    });
  });

  it('reads a live snapshot over the Docker Engine Unix socket', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'velora-docker-engine-'));
    const socketPath = join(directory, 'docker.sock');
    const server = createServer((request, response) => {
      const path = request.url ?? '';
      let payload: unknown;

      if (path === '/containers/json?all=false&size=true') {
        payload = [
          {
            Id: 'engine-container',
            Names: ['/engine-container'],
            Labels: { 'com.docker.compose.service': 'monitoring-service' },
            SizeRw: 256,
          },
        ];
      } else if (path === '/containers/engine-container/stats?stream=false') {
        payload = {
          cpu_stats: {
            cpu_usage: { total_usage: 2_000_000 },
            system_cpu_usage: 20_000_000,
            online_cpus: 2,
          },
          precpu_stats: {
            cpu_usage: { total_usage: 1_000_000 },
            system_cpu_usage: 10_000_000,
          },
          memory_stats: { usage: 500, stats: { inactive_file: 100 } },
        };
      } else if (path === '/containers/engine-container/json?size=true') {
        payload = { HostConfig: { Memory: 2048 } };
      }

      response.statusCode = payload === undefined ? 404 : 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(payload ?? { message: 'not found' }));
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => resolve());
    });

    try {
      const service = new DockerEngineService(
        new ConfigService({
          DOCKER_ENGINE_SOCKET: socketPath,
          DOCKER_ENGINE_TIMEOUT_MS: '1000',
        }),
      );

      await expect(service.snapshot()).resolves.toEqual([
        {
          service: 'monitoring-service',
          container: 'engine-container',
          cpuCores: 0.2,
          memoryWorkingSetBytes: 400,
          memoryLimitBytes: 2048,
          filesystemUsageBytes: 256,
        },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps available containers when one stats request fails', async () => {
    const service = new DockerEngineService(config);
    const requestJson = jest.spyOn(service as any, 'requestJson');
    requestJson.mockImplementation((path: string) => {
      if (path === '/containers/json?all=false&size=true') {
        return Promise.resolve([
          { Id: 'healthy', Names: ['/healthy'], Labels: {} },
          { Id: 'broken', Names: ['/broken'], Labels: {} },
        ]);
      }

      if (path.includes('/broken/')) {
        return Promise.reject(new Error('stats unavailable'));
      }

      if (path.includes('/stats?stream=false')) {
        return Promise.resolve({ memory_stats: { usage: 10, stats: {} } });
      }

      return Promise.resolve({ HostConfig: { Memory: 0 } });
    });

    await expect(service.snapshot()).resolves.toEqual([
      {
        service: 'healthy',
        container: 'healthy',
        cpuCores: null,
        memoryWorkingSetBytes: 10,
        memoryLimitBytes: null,
        filesystemUsageBytes: null,
      },
    ]);
  });

  it('fails when the engine returns containers but no stats', async () => {
    const service = new DockerEngineService(config);
    const requestJson = jest.spyOn(service as any, 'requestJson');
    requestJson.mockImplementation((path: string) => {
      if (path === '/containers/json?all=false&size=true') {
        return Promise.resolve([{ Id: 'broken', Names: ['/broken'] }]);
      }
      return Promise.reject(new Error('stats unavailable'));
    });

    await expect(service.snapshot()).rejects.toThrow(
      'Docker Engine returned no container stats',
    );
  });
});
