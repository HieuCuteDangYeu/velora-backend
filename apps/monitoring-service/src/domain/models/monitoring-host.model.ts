/**
 * A monitored machine (VPS). The registry is not stored anywhere: every host
 * is a node-exporter scrape target in Prometheus and its metadata travels as
 * target labels (`host`, `host_name`, `host_role`, `host_region`,
 * `host_provider`, `docker_port`). Adding a VPS is one block in
 * infra/monitoring/prometheus/prometheus.yml.
 */

/** Safe to embed in a PromQL/LogQL matcher and in a URL path segment. */
export const HOST_ID_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;

/** Id given to node-exporter series that carry no `host` label yet. */
export const LEGACY_HOST_ID = 'local';

/**
 * `primary` runs the Velora Compose stack (services, Prometheus, monitoring
 * service). `worker` is any additional VPS that only runs a few workloads.
 */
export type MonitoringHostRole = 'primary' | 'worker';

/** How container resources of a host can be read. */
export type MonitoringHostContainers = 'local' | 'remote' | 'none';

/**
 * `unavailable` when node-exporter cannot see the machine's network interfaces
 * (it runs in a bridged container, so node_network_* describes the container's
 * own NIC). The target says so with the label `host_network: unavailable`.
 */
export type MonitoringHostNetwork = 'host' | 'unavailable';

export type MonitoringHostInfo = {
  id: string;
  name: string;
  role: MonitoringHostRole;
  region: string | null;
  provider: string | null;
  /** node-exporter scrape address, e.g. `100.86.68.16:9100`. */
  instance: string;
  containers: MonitoringHostContainers;
  network: MonitoringHostNetwork;
};

export type DockerTcpEndpoint = { host: string; port: number };

/** Server-side view of a host: never sent to clients as is. */
export type MonitoringHostRecord = MonitoringHostInfo & {
  /** Value of the Prometheus `host` label; empty for unlabelled series. */
  label: string;
  /** Present when `containers` is `remote`. */
  dockerEndpoint: DockerTcpEndpoint | null;
  /** Current value of `up` for the node-exporter target. */
  up: boolean;
};

export type MonitoringHostSnapshot = MonitoringHostInfo & {
  up: boolean | null;
  cpuUsageRatio: number | null;
  cpuCount: number | null;
  memoryTotalBytes: number | null;
  memoryAvailableBytes: number | null;
  memoryUsedBytes: number | null;
  memoryUsageRatio: number | null;
  swapTotalBytes: number | null;
  swapFreeBytes: number | null;
  swapUsedBytes: number | null;
  swapUsageRatio: number | null;
  diskTotalBytes: number | null;
  diskAvailableBytes: number | null;
  diskUsedBytes: number | null;
  diskUsageRatio: number | null;
  load1: number | null;
  uptimeSeconds: number | null;
  networkReceiveBytesPerSecond: number | null;
  networkTransmitBytesPerSecond: number | null;
};

export type MonitoringHostFleet = {
  generatedAt: string;
  source: 'prometheus';
  defaultHostId: string | null;
  hosts: MonitoringHostSnapshot[];
};

/** Strips server-only fields so the registry can be returned to clients. */
export const toHostInfo = (record: MonitoringHostInfo): MonitoringHostInfo => ({
  id: record.id,
  name: record.name,
  role: record.role,
  region: record.region,
  provider: record.provider,
  instance: record.instance,
  containers: record.containers,
  network: record.network,
});
