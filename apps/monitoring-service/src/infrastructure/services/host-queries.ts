/**
 * PromQL for host (VPS) metrics. Every query is built from a "scope": the label
 * matchers that select the node-exporter series of one host, or of all hosts
 * grouped by `host` (the fleet view). Keeping one builder for both views means
 * a host card, its detail page and its history chart can never disagree.
 */

export const NODE_EXPORTER_JOB = 'job="node-exporter"';

/**
 * The machine that runs the Velora Compose stack. Service process counters
 * (velora_process_cpu_*) are fractions of this machine's cores, so they are
 * divided by its CPU count, never by the whole fleet's. An unlabelled series
 * (a Prometheus config from before multi-host support) counts as primary.
 */
export const PRIMARY_HOST_SCOPE = `${NODE_EXPORTER_JOB},host_role!="worker"`;

const HOST_FILESYSTEM_MATCHERS =
  'mountpoint=~"^/$|^/opt/orbstack-guest/data$",fstype!~"tmpfs|overlay|squashfs"';

// Physical traffic only: container bridges, veth pairs and the Tailscale
// interface would count the same bytes twice.
const PHYSICAL_NETWORK_DEVICES =
  'device!~"lo|veth.*|docker.*|br-.*|virbr.*|tailscale.*|tun.*|utun.*"';

/** PromQL double-quoted string literal. */
export const promString = (value: string): string => JSON.stringify(value);

/**
 * Scope selecting the node-exporter series of one registered host. An empty
 * label (`host=""`) matches series that carry no host label at all, which is
 * how a Prometheus config from before multi-host support keeps working.
 */
export const hostScope = (host: { label: string }): string =>
  `${NODE_EXPORTER_JOB},host=${promString(host.label)}`;

const aggregate = (fn: string, byHost: boolean, expression: string): string =>
  byHost ? `${fn} by (host) (${expression})` : `${fn}(${expression})`;

export type HostBaseMetric =
  | 'cpuUsageRatio'
  | 'cpuCount'
  | 'memoryTotalBytes'
  | 'memoryAvailableBytes'
  | 'swapTotalBytes'
  | 'swapFreeBytes'
  | 'diskTotalBytes'
  | 'diskAvailableBytes'
  | 'load1'
  | 'uptimeSeconds'
  | 'networkReceiveBytesPerSecond'
  | 'networkTransmitBytesPerSecond';

export const hostBaseQueries = (
  scope: string,
  byHost: boolean,
): Record<HostBaseMetric, string> => ({
  cpuUsageRatio: `1 - ${aggregate(
    'avg',
    byHost,
    `rate(node_cpu_seconds_total{${scope},mode="idle"}[1m])`,
  )}`,
  cpuCount: aggregate(
    'count',
    byHost,
    `node_cpu_seconds_total{${scope},mode="idle"}`,
  ),
  memoryTotalBytes: aggregate(
    'max',
    byHost,
    `node_memory_MemTotal_bytes{${scope}}`,
  ),
  memoryAvailableBytes: aggregate(
    'max',
    byHost,
    `node_memory_MemAvailable_bytes{${scope}}`,
  ),
  swapTotalBytes: aggregate(
    'max',
    byHost,
    `node_memory_SwapTotal_bytes{${scope}}`,
  ),
  swapFreeBytes: aggregate(
    'max',
    byHost,
    `node_memory_SwapFree_bytes{${scope}}`,
  ),
  diskTotalBytes: aggregate(
    'max',
    byHost,
    `node_filesystem_size_bytes{${scope},${HOST_FILESYSTEM_MATCHERS}}`,
  ),
  diskAvailableBytes: aggregate(
    'max',
    byHost,
    `node_filesystem_avail_bytes{${scope},${HOST_FILESYSTEM_MATCHERS}}`,
  ),
  load1: aggregate('max', byHost, `node_load1{${scope}}`),
  uptimeSeconds: aggregate(
    'max',
    byHost,
    `time() - node_boot_time_seconds{${scope}}`,
  ),
  networkReceiveBytesPerSecond: aggregate(
    'sum',
    byHost,
    `rate(node_network_receive_bytes_total{${scope},${PHYSICAL_NETWORK_DEVICES}}[1m])`,
  ),
  networkTransmitBytesPerSecond: aggregate(
    'sum',
    byHost,
    `rate(node_network_transmit_bytes_total{${scope},${PHYSICAL_NETWORK_DEVICES}}[1m])`,
  ),
});

/** Metric names accepted by the host timeseries endpoints. */
export const HOST_TIMESERIES_METRICS = [
  'host_cpu',
  'host_memory',
  'host_swap',
  'host_disk',
  'host_load1',
  'host_network_receive',
  'host_network_transmit',
] as const;

export type HostTimeseriesMetric = (typeof HOST_TIMESERIES_METRICS)[number];

export const HOST_TIMESERIES_METRIC_SET: ReadonlySet<string> = new Set(
  HOST_TIMESERIES_METRICS,
);

export const hostTimeseriesQuery = (
  metric: HostTimeseriesMetric,
  scope: string,
  byHost = false,
): string => {
  const q = hostBaseQueries(scope, byHost);

  switch (metric) {
    case 'host_cpu':
      return q.cpuUsageRatio;
    case 'host_memory':
      return `1 - (${q.memoryAvailableBytes} / clamp_min(${q.memoryTotalBytes}, 1))`;
    case 'host_swap':
      return `(${q.swapTotalBytes} - ${q.swapFreeBytes}) / clamp_min(${q.swapTotalBytes}, 1)`;
    case 'host_disk':
      return `1 - (${q.diskAvailableBytes} / clamp_min(${q.diskTotalBytes}, 1))`;
    case 'host_load1':
      return q.load1;
    case 'host_network_receive':
      return q.networkReceiveBytesPerSecond;
    case 'host_network_transmit':
      return q.networkTransmitBytesPerSecond;
  }
};
