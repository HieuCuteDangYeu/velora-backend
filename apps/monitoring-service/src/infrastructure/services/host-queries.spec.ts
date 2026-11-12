import {
  hostBaseQueries,
  hostScope,
  hostTimeseriesQuery,
  HOST_TIMESERIES_METRICS,
  NODE_EXPORTER_JOB,
  PRIMARY_HOST_SCOPE,
  promString,
} from './host-queries';

describe('host queries', () => {
  it('scopes a registered host by its label, and an unlabelled host by an empty label', () => {
    expect(hostScope({ label: 'velora-node-2' })).toBe(
      'job="node-exporter",host="velora-node-2"',
    );
    // host="" matches series that have no host label at all.
    expect(hostScope({ label: '' })).toBe('job="node-exporter",host=""');
  });

  it('quotes label values so they cannot break out of the matcher', () => {
    expect(promString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it('treats every host except a worker as the primary machine', () => {
    expect(PRIMARY_HOST_SCOPE).toBe('job="node-exporter",host_role!="worker"');
  });

  it('builds the same expression for one host and for the fleet', () => {
    const single = hostBaseQueries('job="node-exporter",host="a"', false);
    const fleet = hostBaseQueries(NODE_EXPORTER_JOB, true);

    expect(single.cpuUsageRatio).toBe(
      '1 - avg(rate(node_cpu_seconds_total{job="node-exporter",host="a",mode="idle"}[1m]))',
    );
    expect(fleet.cpuUsageRatio).toBe(
      '1 - avg by (host) (rate(node_cpu_seconds_total{job="node-exporter",mode="idle"}[1m]))',
    );
    expect(fleet.cpuCount).toBe(
      'count by (host) (node_cpu_seconds_total{job="node-exporter",mode="idle"})',
    );
    expect(fleet.load1).toBe('max by (host) (node_load1{job="node-exporter"})');
  });

  it('counts physical network interfaces only', () => {
    const { networkReceiveBytesPerSecond, networkTransmitBytesPerSecond } =
      hostBaseQueries(NODE_EXPORTER_JOB, true);

    for (const query of [
      networkReceiveBytesPerSecond,
      networkTransmitBytesPerSecond,
    ]) {
      expect(query).toContain('sum by (host) (rate(');
      expect(query).toContain(
        'device!~"lo|veth.*|docker.*|br-.*|virbr.*|tailscale.*|tun.*|utun.*"',
      );
      expect(query).toContain('[1m]');
    }
  });

  it('keeps the existing ratio shapes for every host timeseries metric', () => {
    const scope = 'job="node-exporter",host="a"';

    expect(hostTimeseriesQuery('host_memory', scope)).toBe(
      '1 - (max(node_memory_MemAvailable_bytes{job="node-exporter",host="a"}) / clamp_min(max(node_memory_MemTotal_bytes{job="node-exporter",host="a"}), 1))',
    );
    expect(hostTimeseriesQuery('host_swap', scope)).toContain(
      'clamp_min(max(node_memory_SwapTotal_bytes{job="node-exporter",host="a"}), 1)',
    );
    expect(hostTimeseriesQuery('host_disk', scope)).toContain(
      'mountpoint=~"^/$|^/opt/orbstack-guest/data$"',
    );
    expect(hostTimeseriesQuery('host_load1', scope)).toBe(
      'max(node_load1{job="node-exporter",host="a"})',
    );
  });

  it('groups fleet history by host for every metric', () => {
    for (const metric of HOST_TIMESERIES_METRICS) {
      expect(hostTimeseriesQuery(metric, NODE_EXPORTER_JOB, true)).toContain(
        'by (host)',
      );
    }
  });
});
