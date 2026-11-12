import { RpcException } from '@nestjs/microservices';
import {
  defaultHostOf,
  HostRegistryService,
  mergeHostRecords,
  parseHostSample,
} from './host-registry.service';

const sample = (metric: Record<string, string>, value = 1) => ({
  metric,
  timestamp: 1,
  value,
});

describe('host registry', () => {
  describe('parseHostSample', () => {
    it('reads the host metadata from the Prometheus target labels', () => {
      expect(
        parseHostSample(
          sample({
            host: 'velora-node-2',
            host_name: 'Velora node 2',
            host_role: 'worker',
            host_region: 'France',
            host_provider: 'Contabo',
            instance: '100.86.68.16:9100',
            docker_port: '2375',
          }),
        ),
      ).toEqual({
        id: 'velora-node-2',
        label: 'velora-node-2',
        name: 'Velora node 2',
        role: 'worker',
        region: 'France',
        provider: 'Contabo',
        instance: '100.86.68.16:9100',
        containers: 'remote',
        network: 'host',
        dockerEndpoint: { host: '100.86.68.16', port: 2375 },
        up: true,
      });
    });

    it('keeps an unlabelled node-exporter usable as the primary host', () => {
      expect(
        parseHostSample(sample({ instance: 'node-exporter:9100' })),
      ).toMatchObject({
        id: 'local',
        label: '',
        name: 'local',
        role: 'primary',
        containers: 'local',
        dockerEndpoint: null,
      });
    });

    it('marks a host whose exporter cannot see the machine network', () => {
      expect(
        parseHostSample(
          sample({
            host: 'home',
            host_network: 'unavailable',
            instance: 'a:1',
          }),
        )?.network,
      ).toBe('unavailable');
      expect(parseHostSample(sample({ host: 'home' }))?.network).toBe('host');
      // Only the exact value counts: a typo must not hide real data.
      expect(
        parseHostSample(sample({ host: 'home', host_network: 'no' }))?.network,
      ).toBe('host');
    });

    it('has no container access for a worker without a Docker port', () => {
      expect(
        parseHostSample(
          sample({
            host: 'edge',
            host_role: 'worker',
            instance: '10.0.0.5:9100',
          }),
        ),
      ).toMatchObject({ role: 'worker', containers: 'none' });
    });

    it.each(['0', '65536', 'abc', '22.5'])(
      'ignores the invalid Docker port %s',
      (docker_port) => {
        expect(
          parseHostSample(
            sample({
              host: 'edge',
              host_role: 'worker',
              instance: '10.0.0.5:9100',
              docker_port,
            }),
          ),
        ).toMatchObject({ containers: 'none', dockerEndpoint: null });
      },
    );

    it('reads IPv6 and hostname instances', () => {
      expect(
        parseHostSample(
          sample({
            host: 'v6',
            host_role: 'worker',
            instance: '[fd7a:115c::1]:9100',
            docker_port: '2375',
          }),
        )?.dockerEndpoint,
      ).toEqual({ host: 'fd7a:115c::1', port: 2375 });
      expect(
        parseHostSample(
          sample({
            host: 'named',
            host_role: 'worker',
            instance: 'vps.example.com:9100',
            docker_port: '2375',
          }),
        )?.dockerEndpoint,
      ).toEqual({ host: 'vps.example.com', port: 2375 });
    });

    it('rejects a host label that is unsafe to embed in a query', () => {
      expect(
        parseHostSample(
          sample({ host: 'x"} or vector(1) #', instance: 'a:1' }),
        ),
      ).toBeNull();
    });

    it('marks a target with value 0 as down', () => {
      expect(parseHostSample(sample({ host: 'a' }, 0))?.up).toBe(false);
    });
  });

  describe('mergeHostRecords', () => {
    it('lists the primary machine first, then workers by name', () => {
      const hosts = mergeHostRecords([
        sample({ host: 'zeta', host_name: 'Zeta', host_role: 'worker' }),
        sample({ host: 'home', host_name: 'Homelab' }),
        sample({ host: 'alpha', host_name: 'Alpha', host_role: 'worker' }),
      ]);

      expect(hosts.map((host) => host.id)).toEqual(['home', 'alpha', 'zeta']);
      expect(defaultHostOf(hosts)?.id).toBe('home');
    });

    it('drops the unlabelled leftover of a host that now has labels', () => {
      // Prometheus was restarted with new target labels: for five minutes the
      // old series (no host label) and the new ones are both visible.
      const hosts = mergeHostRecords([
        sample({ instance: 'node-exporter:9100' }),
        sample({ host: 'home', instance: 'node-exporter:9100' }),
      ]);

      expect(hosts.map((host) => host.id)).toEqual(['home']);
    });

    it('keeps the network warning while old and new series of a host are both visible', () => {
      const [first] = mergeHostRecords([
        sample({ host: 'home', instance: 'a:1' }),
        sample({ host: 'home', host_network: 'unavailable', instance: 'a:1' }),
      ]);
      const [second] = mergeHostRecords([
        sample({ host: 'home', host_network: 'unavailable', instance: 'a:1' }),
        sample({ host: 'home', instance: 'a:1' }),
      ]);

      expect(first.network).toBe('unavailable');
      expect(second.network).toBe('unavailable');
    });

    it('keeps an unlabelled host when no labelled series shares its address', () => {
      const hosts = mergeHostRecords([
        sample({ instance: 'node-exporter:9100' }),
        sample({
          host: 'node-2',
          host_role: 'worker',
          instance: '10.0.0.2:9100',
        }),
      ]);

      expect(hosts.map((host) => host.id).sort()).toEqual(['local', 'node-2']);
    });

    it('treats a host as up when any of its targets is up', () => {
      const [host] = mergeHostRecords([
        sample({ host: 'a', instance: 'a:1' }, 0),
        sample({ host: 'a', instance: 'a:2' }, 1),
      ]);

      expect(host.up).toBe(true);
    });

    it('opens the first host when no machine is marked primary', () => {
      const hosts = mergeHostRecords([
        sample({ host: 'only', host_role: 'worker' }),
      ]);

      expect(defaultHostOf(hosts)?.id).toBe('only');
      expect(defaultHostOf([])).toBeNull();
    });
  });

  describe('HostRegistryService', () => {
    it('shares one Prometheus query between callers and rejects unknown hosts', async () => {
      const prometheus = {
        vector: jest.fn().mockResolvedValue([sample({ host: 'home' })]),
      };
      const registry = new HostRegistryService(prometheus as never);

      await expect(registry.require('home')).resolves.toMatchObject({
        id: 'home',
      });
      await expect(registry.list()).resolves.toHaveLength(1);
      expect(prometheus.vector).toHaveBeenCalledTimes(1);
      expect(prometheus.vector).toHaveBeenCalledWith('up{job="node-exporter"}');

      await expect(registry.require('nope')).rejects.toEqual(
        new RpcException({ statusCode: 404, message: 'Unknown host "nope"' }),
      );
    });
  });
});
