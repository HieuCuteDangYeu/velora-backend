import { SystemAlertsController } from './system-alerts.controller';

describe('SystemAlertsController', () => {
  const prometheus = { activeAlerts: jest.fn() };
  const metrics = { recordRpc: jest.fn() };
  const controller = new SystemAlertsController(
    prometheus as never,
    metrics as never,
  );

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('normalizes severity and routing service for host and service alerts', async () => {
    prometheus.activeAlerts.mockResolvedValue([
      {
        labels: {
          alertname: 'VeloraHostHighCpu',
          severity: 'warning',
          service: 'node-exporter',
        },
        annotations: {
          summary: 'host CPU is high',
          description: 'CPU is above the configured threshold.',
        },
        state: 'firing',
        activeAt: '2026-01-01T00:00:00.000Z',
        value: 0.8,
      },
      {
        labels: {
          alertname: 'VeloraConversationServiceDown',
          severity: 'critical',
          service: 'conversation-service',
        },
        annotations: {
          summary: 'conversation-service is unavailable',
          description: 'The target is down.',
        },
        state: 'pending',
        activeAt: '2026-01-01T00:01:00.000Z',
        value: 0,
      },
      {
        labels: {
          alertname: 'VeloraCallServiceDown',
          severity: 'critical',
          service: 'call-service',
        },
        annotations: {
          summary: 'call-service is unavailable',
          description: 'The target is down.',
        },
        state: 'firing',
        activeAt: '2026-01-01T00:02:00.000Z',
        value: 0,
      },
      {
        labels: {
          alertname: 'VeloraMonitoringServiceDown',
          severity: 'critical',
          job: 'monitoring-service',
        },
        annotations: {
          summary: 'monitoring-service is unavailable',
          description: 'The target is down.',
        },
        state: 'firing',
        activeAt: '2026-01-01T00:03:00.000Z',
        value: 0,
      },
    ]);

    const response = await controller.list();

    expect(response.counts).toEqual({
      total: 4,
      firing: 3,
      pending: 1,
      critical: 3,
      warning: 1,
    });
    expect(
      response.alerts.map((alert) => [
        alert.name,
        alert.service,
        alert.severity,
      ]),
    ).toEqual([
      ['VeloraCallServiceDown', 'call-service', 'critical'],
      ['VeloraMonitoringServiceDown', 'monitoring-service', 'critical'],
      ['VeloraHostHighCpu', 'node-exporter', 'warning'],
      ['VeloraConversationServiceDown', 'conversation-service', 'critical'],
    ]);
  });
});
