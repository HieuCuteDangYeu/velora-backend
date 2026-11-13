import type {
  MonitoringHostFleet,
  MonitoringHostRecord,
  MonitoringHostSnapshot,
} from '@monitoring/domain/models/monitoring-host.model';
import { toHostInfo } from '@monitoring/domain/models/monitoring-host.model';
import { Injectable } from '@nestjs/common';
import {
  defaultHostOf,
  HOST_REGISTRY_QUERY,
  mergeHostRecords,
} from './host-registry.service';
import {
  hostBaseQueries,
  NODE_EXPORTER_JOB,
  type HostBaseMetric,
} from './host-queries';
import { subtractMetric, usageRatio } from './metric-math';
import { PrometheusQueryService } from './prometheus-query.service';
import { TtlSingleFlight } from './ttl-single-flight';

/** One Prometheus scrape interval: a fresher snapshot would repeat itself. */
const FLEET_TTL_MS = 5_000;

type HostValues = Record<HostBaseMetric, Map<string, number>>;

const snapshotOf = (
  record: MonitoringHostRecord,
  values: HostValues,
): MonitoringHostSnapshot => {
  const read = (metric: HostBaseMetric): number | null =>
    values[metric].get(record.label) ?? null;

  const memoryTotalBytes = read('memoryTotalBytes');
  const memoryAvailableBytes = read('memoryAvailableBytes');
  const memoryUsedBytes = subtractMetric(
    memoryTotalBytes,
    memoryAvailableBytes,
  );
  const swapTotalBytes = read('swapTotalBytes');
  const swapFreeBytes = read('swapFreeBytes');
  const swapUsedBytes = subtractMetric(swapTotalBytes, swapFreeBytes);
  const diskTotalBytes = read('diskTotalBytes');
  const diskAvailableBytes = read('diskAvailableBytes');
  const diskUsedBytes = subtractMetric(diskTotalBytes, diskAvailableBytes);

  return {
    ...toHostInfo(record),
    up: record.up,
    cpuUsageRatio: read('cpuUsageRatio'),
    cpuCount: read('cpuCount'),
    memoryTotalBytes,
    memoryAvailableBytes,
    memoryUsedBytes,
    memoryUsageRatio: usageRatio(memoryUsedBytes, memoryTotalBytes),
    swapTotalBytes,
    swapFreeBytes,
    swapUsedBytes,
    swapUsageRatio: usageRatio(swapUsedBytes, swapTotalBytes),
    diskTotalBytes,
    diskAvailableBytes,
    diskUsedBytes,
    diskUsageRatio: usageRatio(diskUsedBytes, diskTotalBytes),
    load1: read('load1'),
    uptimeSeconds: read('uptimeSeconds'),
    // A bridged exporter only sees its own container's NIC: report no figure
    // rather than a wrong one.
    networkReceiveBytesPerSecond:
      record.network === 'host' ? read('networkReceiveBytesPerSecond') : null,
    networkTransmitBytesPerSecond:
      record.network === 'host' ? read('networkTransmitBytesPerSecond') : null,
  };
};

/**
 * Current state of every host. The number of Prometheus queries is fixed
 * (one per metric, grouped by host), so a fleet of ten machines costs the same
 * as one, and concurrent dashboards share a single batch per scrape interval.
 */
@Injectable()
export class HostMetricsService {
  private readonly cache = new TtlSingleFlight<MonitoringHostFleet>(
    FLEET_TTL_MS,
  );

  constructor(private readonly prometheus: PrometheusQueryService) {}

  fleet(): Promise<MonitoringHostFleet> {
    return this.cache.get(() => this.load());
  }

  private async load(): Promise<MonitoringHostFleet> {
    const queries = hostBaseQueries(NODE_EXPORTER_JOB, true);
    const metrics = Object.keys(queries) as HostBaseMetric[];

    const [targets, ...samples] = await Promise.all([
      this.prometheus.vector(HOST_REGISTRY_QUERY),
      ...metrics.map((metric) => this.prometheus.vector(queries[metric])),
    ]);

    const values = Object.fromEntries(
      metrics.map((metric, index) => [
        metric,
        new Map(
          samples[index].map((sample) => [
            sample.metric.host ?? '',
            sample.value,
          ]),
        ),
      ]),
    ) as HostValues;

    const records = mergeHostRecords(targets);

    return {
      generatedAt: new Date().toISOString(),
      source: 'prometheus',
      defaultHostId: defaultHostOf(records)?.id ?? null,
      hosts: records.map((record) => snapshotOf(record, values)),
    };
  }
}
