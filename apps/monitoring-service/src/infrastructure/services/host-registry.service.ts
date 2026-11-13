import {
  HOST_ID_PATTERN,
  LEGACY_HOST_ID,
  type DockerTcpEndpoint,
  type MonitoringHostRecord,
} from '@monitoring/domain/models/monitoring-host.model';
import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import {
  PrometheusQueryService,
  type PrometheusInstantSample,
} from './prometheus-query.service';
import { NODE_EXPORTER_JOB } from './host-queries';
import { TtlSingleFlight } from './ttl-single-flight';

/** Host metadata changes only when someone edits prometheus.yml. */
const REGISTRY_TTL_MS = 10_000;

export const HOST_REGISTRY_QUERY = `up{${NODE_EXPORTER_JOB}}`;

const clean = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

/** `100.86.68.16:9100` -> `100.86.68.16`; `[fd7a::1]:9100` -> `fd7a::1`. */
const hostOfInstance = (instance: string): string | null => {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(instance);
  if (bracketed) return bracketed[1];

  const separator = instance.lastIndexOf(':');
  const host = separator === -1 ? instance : instance.slice(0, separator);
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(host) ? host : null;
};

const dockerEndpointOf = (
  instance: string,
  dockerPort: string | null,
): DockerTcpEndpoint | null => {
  if (dockerPort === null) return null;

  const port = Number(dockerPort);
  const host = hostOfInstance(instance);
  return host !== null && Number.isInteger(port) && port > 0 && port <= 65535
    ? { host, port }
    : null;
};

/**
 * Turns one `up{job="node-exporter"}` sample into a host record. Series with an
 * unusable `host` label are skipped so a typo in prometheus.yml cannot inject
 * anything into a later query.
 */
export const parseHostSample = (
  sample: Pick<PrometheusInstantSample, 'metric' | 'value'>,
): MonitoringHostRecord | null => {
  const labels = sample.metric;
  const label = labels.host?.trim() ?? '';
  const id = label || LEGACY_HOST_ID;
  if (!HOST_ID_PATTERN.test(id)) return null;

  const role = labels.host_role?.trim() === 'worker' ? 'worker' : 'primary';
  const instance = labels.instance?.trim() ?? '';
  const dockerEndpoint = dockerEndpointOf(instance, clean(labels.docker_port));

  return {
    id,
    label,
    name: clean(labels.host_name) ?? id,
    role,
    region: clean(labels.host_region),
    provider: clean(labels.host_provider),
    instance,
    // The monitoring service sees only its own machine through the socket; a
    // remote worker needs a Docker API endpoint (`docker_port` label).
    containers: dockerEndpoint
      ? 'remote'
      : role === 'primary'
        ? 'local'
        : 'none',
    network:
      labels.host_network?.trim() === 'unavailable' ? 'unavailable' : 'host',
    dockerEndpoint,
    up: sample.value > 0,
  };
};

/**
 * One record per host id; a host is up when any of its targets is up.
 *
 * After Prometheus is restarted with new target labels, the series from before
 * stay visible for the 5-minute staleness window. An unlabelled record whose
 * scrape address also appears with a `host` label is that leftover (the same
 * machine, seen twice), so it is dropped instead of showing a ghost host.
 */
export const mergeHostRecords = (
  samples: readonly Pick<PrometheusInstantSample, 'metric' | 'value'>[],
): MonitoringHostRecord[] => {
  const byId = new Map<string, MonitoringHostRecord>();

  for (const sample of samples) {
    const record = parseHostSample(sample);
    if (!record) continue;

    const existing = byId.get(record.id);
    byId.set(
      record.id,
      existing
        ? {
            ...existing,
            up: existing.up || record.up,
            // Right after a label change both the old and the new `up` series
            // are visible: never show traffic figures if either says they are wrong.
            network:
              existing.network === 'unavailable' ||
              record.network === 'unavailable'
                ? 'unavailable'
                : 'host',
          }
        : record,
    );
  }

  const records = [...byId.values()];
  const labelledInstances = new Set(
    records
      .filter((record) => record.label !== '')
      .map((record) => record.instance),
  );

  return records
    .filter(
      (record) =>
        record.label !== '' || !labelledInstances.has(record.instance),
    )
    .sort(
      (left, right) =>
        Number(right.role === 'primary') - Number(left.role === 'primary') ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id),
    );
};

/** The host the dashboard opens first: the primary machine. */
export const defaultHostOf = (
  hosts: readonly MonitoringHostRecord[],
): MonitoringHostRecord | null =>
  hosts.find((host) => host.role === 'primary') ?? hosts[0] ?? null;

@Injectable()
export class HostRegistryService {
  private readonly cache = new TtlSingleFlight<MonitoringHostRecord[]>(
    REGISTRY_TTL_MS,
  );

  constructor(private readonly prometheus: PrometheusQueryService) {}

  list(): Promise<MonitoringHostRecord[]> {
    return this.cache.get(async () =>
      mergeHostRecords(await this.prometheus.vector(HOST_REGISTRY_QUERY)),
    );
  }

  async require(id: string): Promise<MonitoringHostRecord> {
    const host = (await this.list()).find((record) => record.id === id);
    if (!host) {
      throw new RpcException({
        statusCode: 404,
        message: `Unknown host "${id}"`,
      });
    }

    return host;
  }
}
