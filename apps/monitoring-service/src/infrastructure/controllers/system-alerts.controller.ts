import { Controller } from '@nestjs/common';
import { MessagePattern, RpcException } from '@nestjs/microservices';
import { PrometheusMetricsService } from '../metrics/prometheus-metrics.service';
import {
  PrometheusQueryService,
  type PrometheusActiveAlert,
} from '../services/prometheus-query.service';

type AlertSeverity = 'critical' | 'warning' | 'info';

@Controller()
export class SystemAlertsController {
  constructor(
    private readonly prometheus: PrometheusQueryService,
    private readonly metrics: PrometheusMetricsService,
  ) {}

  @MessagePattern('system.alerts.list')
  async list() {
    return this.measure('system.alerts.list', async () => {
      try {
        const alerts = (await this.prometheus.activeAlerts())
          .map((alert) => this.normalizeAlert(alert))
          .sort((left, right) => {
            const stateRank = { firing: 0, pending: 1 } as const;
            const severityRank = { critical: 0, warning: 1, info: 2 } as const;
            return (
              stateRank[left.state] - stateRank[right.state] ||
              severityRank[left.severity] - severityRank[right.severity] ||
              left.name.localeCompare(right.name)
            );
          });

        return {
          generatedAt: new Date().toISOString(),
          source: 'prometheus' as const,
          counts: {
            total: alerts.length,
            firing: alerts.filter((alert) => alert.state === 'firing').length,
            pending: alerts.filter((alert) => alert.state === 'pending').length,
            critical: alerts.filter(
              (alert) => alert.severity === 'critical',
            ).length,
            warning: alerts.filter(
              (alert) => alert.severity === 'warning',
            ).length,
          },
          alerts,
        };
      } catch (error) {
        throw this.prometheusError(error);
      }
    });
  }

  private normalizeAlert(alert: PrometheusActiveAlert) {
    const severity = this.normalizeSeverity(alert.labels.severity);
    const name = alert.labels.alertname || 'Unnamed alert';
    const service =
      alert.labels.service || alert.labels.job || alert.labels.instance || 'unknown';

    return {
      name,
      state: alert.state,
      severity,
      service,
      activeAt: alert.activeAt,
      value: alert.value,
      summary: alert.annotations.summary || name,
      description: alert.annotations.description || '',
      labels: alert.labels,
      annotations: alert.annotations,
    };
  }

  private normalizeSeverity(value: string | undefined): AlertSeverity {
    if (value === 'critical' || value === 'warning') return value;
    return 'info';
  }

  private prometheusError(error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Prometheus alert query failed';
    return new RpcException({ statusCode: 503, message });
  }

  private async measure<T>(
    pattern: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const startedAt = process.hrtime.bigint();
    let status: 'success' | 'error' = 'success';

    try {
      return await operation();
    } catch (error) {
      status = 'error';
      throw error;
    } finally {
      this.metrics.recordRpc(
        pattern,
        status,
        Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
      );
    }
  }
}
