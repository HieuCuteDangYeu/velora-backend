import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { request } from 'node:http';

type JsonRecord = Record<string, unknown>;

type DockerContainerSummary = {
  Id?: unknown;
  Names?: unknown;
  Labels?: unknown;
  SizeRw?: unknown;
};

type DockerContainerInspect = {
  Config?: JsonRecord;
  HostConfig?: JsonRecord;
};

type DockerCpuStats = {
  cpu_usage?: JsonRecord;
  system_cpu_usage?: unknown;
  online_cpus?: unknown;
};

type DockerMemoryStats = {
  usage?: unknown;
  stats?: JsonRecord;
};

type DockerStats = {
  cpu_stats?: DockerCpuStats;
  precpu_stats?: DockerCpuStats;
  memory_stats?: DockerMemoryStats;
};

type DockerSystemDf = {
  LayersSize?: unknown;
  Volumes?: unknown;
  BuildCache?: unknown;
};

type DockerInfo = {
  NCPU?: unknown;
};

export type DockerContainerResource = {
  service: string;
  container: string;
  cpuCores: number | null;
  memoryWorkingSetBytes: number | null;
  memoryLimitBytes: number | null;
  filesystemUsageBytes: number | null;
};

export type DockerStorageSummary = {
  imagesBytes: number | null;
  volumesBytes: number | null;
  buildCacheBytes: number | null;
};

export type DockerSnapshotMetadata = {
  hostCpuCount: number | null;
  storage: DockerStorageSummary;
};

export type DockerSnapshot = {
  containers: DockerContainerResource[];
  runningContainers: number;
  sampledContainers: number;
};

const DEFAULT_SOCKET_PATH = '/var/run/docker.sock';
const DEFAULT_TIMEOUT_MS = 4000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const finiteNumber = (value: unknown): number | null => {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
};

const recordValue = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;

const stringValue = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const labelsFrom = (value: unknown): Record<string, string> => {
  const record = recordValue(value);
  if (!record) return {};

  return Object.fromEntries(
    Object.entries(record).flatMap(([key, item]) => {
      const label = stringValue(item);
      return label === null ? [] : [[key, label]];
    }),
  );
};

const firstName = (value: unknown): string | null => {
  if (!Array.isArray(value)) return null;

  const name = value.find((item): item is string => typeof item === 'string');
  return name ? name.replace(/^\/+/, '').trim() || null : null;
};

const cpuCoresFrom = (stats: DockerStats): number | null => {
  const current = stats.cpu_stats;
  const previous = stats.precpu_stats;
  const currentUsage = finiteNumber(current?.cpu_usage?.total_usage);
  const previousUsage = finiteNumber(previous?.cpu_usage?.total_usage);
  const currentSystem = finiteNumber(current?.system_cpu_usage);
  const previousSystem = finiteNumber(previous?.system_cpu_usage);
  const cpuCount =
    finiteNumber(current?.online_cpus) ??
    (Array.isArray(current?.cpu_usage?.percpu_usage)
      ? current.cpu_usage.percpu_usage.length
      : null);

  if (
    currentUsage === null ||
    previousUsage === null ||
    currentSystem === null ||
    previousSystem === null ||
    cpuCount === null
  ) {
    return null;
  }

  const usageDelta = currentUsage - previousUsage;
  const systemDelta = currentSystem - previousSystem;
  if (usageDelta < 0 || systemDelta <= 0 || cpuCount <= 0) return null;

  return Math.max(0, (usageDelta / systemDelta) * cpuCount);
};

const memoryWorkingSetFrom = (stats: DockerStats): number | null => {
  const memory = stats.memory_stats;
  const usage = finiteNumber(memory?.usage);
  if (usage === null) return null;

  const memoryStats = memory?.stats;
  const cache =
    finiteNumber(memoryStats?.total_inactive_file) ??
    finiteNumber(memoryStats?.inactive_file) ??
    finiteNumber(memoryStats?.cache) ??
    0;

  return Math.max(0, usage - Math.max(0, cache));
};

const memoryLimitFrom = (
  inspect: DockerContainerInspect | null,
): number | null => {
  const value = finiteNumber(inspect?.HostConfig?.Memory);
  return value !== null && value > 0 ? value : null;
};

const filesystemUsageFrom = (
  summary: DockerContainerSummary,
): number | null => {
  const value = finiteNumber(summary.SizeRw);
  return value !== null && value >= 0 ? value : null;
};

const nonNegativeNumber = (value: unknown): number | null => {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
};

const sumUsageDataSizes = (value: unknown): number | null => {
  if (!Array.isArray(value)) return null;
  if (value.length === 0) return 0;

  const sizes = value.flatMap((item) => {
    const record = recordValue(item);
    const usageData = recordValue(record?.UsageData);
    const size = nonNegativeNumber(usageData?.Size);
    return size === null ? [] : [size];
  });

  return sizes.length > 0
    ? sizes.reduce((total, size) => total + size, 0)
    : null;
};

const sumBuildCacheSizes = (value: unknown): number | null => {
  if (!Array.isArray(value)) return null;
  if (value.length === 0) return 0;

  const sizes = value.flatMap((item) => {
    const record = recordValue(item);
    const size = nonNegativeNumber(record?.Size);
    return size === null ? [] : [size];
  });

  return sizes.length > 0
    ? sizes.reduce((total, size) => total + size, 0)
    : null;
};

const storageFrom = (value: DockerSystemDf | null): DockerStorageSummary => ({
  imagesBytes: nonNegativeNumber(value?.LayersSize),
  volumesBytes: sumUsageDataSizes(value?.Volumes),
  buildCacheBytes: sumBuildCacheSizes(value?.BuildCache),
});

const hostCpuCountFrom = (value: DockerInfo | null): number | null => {
  const count = nonNegativeNumber(value?.NCPU);
  return count !== null && count > 0 ? Math.round(count) : null;
};

@Injectable()
export class DockerEngineService {
  private readonly socketPath: string;
  private readonly timeoutMs: number;

  constructor(configService: ConfigService) {
    this.socketPath =
      configService.get<string>('DOCKER_ENGINE_SOCKET')?.trim() ||
      DEFAULT_SOCKET_PATH;

    const configuredTimeout = Number(
      configService.get<string>('DOCKER_ENGINE_TIMEOUT_MS') ??
        DEFAULT_TIMEOUT_MS,
    );
    this.timeoutMs =
      Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : DEFAULT_TIMEOUT_MS;
  }

  async snapshot(): Promise<DockerContainerResource[]> {
    const snapshot = await this.snapshotWithCoverage();
    return snapshot.containers;
  }

  async snapshotWithCoverage(): Promise<DockerSnapshot> {
    const summaries = await this.requestJson<DockerContainerSummary[]>(
      '/containers/json?all=false&size=true',
    );

    if (!Array.isArray(summaries)) {
      throw new Error('Docker Engine returned an invalid container list');
    }

    const results = await Promise.allSettled(
      summaries.map((summary) => this.collectContainer(summary)),
    );
    const resources = results.flatMap((result) =>
      result.status === 'fulfilled' && result.value !== null
        ? [result.value]
        : [],
    );

    if (summaries.length > 0 && resources.length === 0) {
      throw new Error('Docker Engine returned no container stats');
    }

    const containers = resources.sort(
      (left, right) =>
        (right.memoryWorkingSetBytes ?? -1) -
        (left.memoryWorkingSetBytes ?? -1),
    );

    return {
      containers,
      runningContainers: summaries.length,
      sampledContainers: containers.length,
    };
  }

  async snapshotMetadata(): Promise<DockerSnapshotMetadata> {
    const [infoResult, storageResult] = await Promise.allSettled([
      this.requestJson<DockerInfo>('/info'),
      this.requestJson<DockerSystemDf>('/system/df'),
    ]);

    return {
      hostCpuCount:
        infoResult.status === 'fulfilled'
          ? hostCpuCountFrom(infoResult.value)
          : null,
      storage:
        storageResult.status === 'fulfilled'
          ? storageFrom(storageResult.value)
          : storageFrom(null),
    };
  }

  private async collectContainer(
    summary: DockerContainerSummary,
  ): Promise<DockerContainerResource | null> {
    const id = stringValue(summary.Id);
    if (!id) return null;

    const name = firstName(summary.Names) || id.slice(0, 12);
    const labels = labelsFrom(summary.Labels);
    const service = labels['com.docker.compose.service'] || name;
    const encodedId = encodeURIComponent(id);

    const [statsResult, inspectResult] = await Promise.allSettled([
      this.requestJson<DockerStats>(
        `/containers/${encodedId}/stats?stream=false`,
      ),
      this.requestJson<DockerContainerInspect>(
        `/containers/${encodedId}/json?size=true`,
      ),
    ]);

    if (statsResult.status !== 'fulfilled') {
      return null;
    }

    const inspect =
      inspectResult.status === 'fulfilled' ? inspectResult.value : null;

    return {
      service,
      container: name,
      cpuCores: cpuCoresFrom(statsResult.value),
      memoryWorkingSetBytes: memoryWorkingSetFrom(statsResult.value),
      memoryLimitBytes: memoryLimitFrom(inspect),
      filesystemUsageBytes: filesystemUsageFrom(summary),
    };
  }

  private requestJson<T>(path: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const clientRequest = request(
        {
          socketPath: this.socketPath,
          path,
          method: 'GET',
          headers: { Accept: 'application/json' },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let length = 0;

          response.on('data', (chunk: Buffer | string) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            length += buffer.length;
            if (length > MAX_RESPONSE_BYTES) {
              response.destroy(
                new Error('Docker Engine response is too large'),
              );
              return;
            }
            chunks.push(buffer);
          });

          response.on('error', reject);
          response.on('end', () => {
            const statusCode = response.statusCode ?? 0;
            const body = Buffer.concat(chunks).toString('utf8');
            if (statusCode < 200 || statusCode >= 300) {
              reject(new Error(`Docker Engine returned HTTP ${statusCode}`));
              return;
            }

            try {
              resolve(JSON.parse(body) as T);
            } catch {
              reject(new Error('Docker Engine returned invalid JSON'));
            }
          });
        },
      );

      clientRequest.setTimeout(this.timeoutMs, () => {
        clientRequest.destroy(
          new Error(
            `Docker Engine request timed out after ${this.timeoutMs}ms`,
          ),
        );
      });
      clientRequest.on('error', reject);
      clientRequest.end();
    });
  }
}
