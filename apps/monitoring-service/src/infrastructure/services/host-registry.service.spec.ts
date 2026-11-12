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
