import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type PrometheusInstantResult = {
  result: Array<{
    metric: Record<string, string>;
    value?: [number, string];
  }>;
};

type PrometheusRangeResult = {
  result: Array<{
    metric: Record<string, string>;
    values?: Array<[number, string]>;
  }>;
};

type PrometheusEnvelope<T> = {
  status: 'success' | 'error';
  data?: T;
  errorType?: string;
  error?: string;
};

@Injectable()
export class PrometheusQueryService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(configService: ConfigService) {
    this.baseUrl = (
      configService.get<string>('PROMETHEUS_URL') ?? 'http://prometheus:9090'
    ).replace(/\/$/, '');

    const configuredTimeout = Number(
      configService.get<string>('PROMETHEUS_QUERY_TIMEOUT_MS') ?? '4000',
    );
    this.timeoutMs =
      Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : 4000;
  }

  async scalar(query: string): Promise<number> {
    return (await this.scalarNullable(query)) ?? 0;
  }

  async scalarNullable(query: string): Promise<number | null> {
    const payload = await this.request<PrometheusInstantResult>(
      '/api/v1/query',
      new URLSearchParams({ query }),
    );
    const rawValue = payload.result[0]?.value?.[1];
    if (rawValue === undefined) return null;
    const value = Number(rawValue);
    return Number.isFinite(value) ? value : null;
  }

  async range(
    query: string,
    from: string,
    to: string,
    stepSeconds: number,
  ): Promise<Array<{ timestamp: number; value: number }>> {
    const payload = await this.request<PrometheusRangeResult>(
      '/api/v1/query_range',
      new URLSearchParams({ query, start: from, end: to, step: String(stepSeconds) }),
    );

    return (payload.result[0]?.values ?? []).flatMap(([timestamp, rawValue]) => {
      const value = Number(rawValue);
      return Number.isFinite(value) ? [{ timestamp, value }] : [];
    });
  }

  private async request<T>(path: string, searchParams: URLSearchParams): Promise<T> {
    const url = `${this.baseUrl}${path}?${searchParams.toString()}`;
    let response: Response;

    try {
      response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      throw new Error(`Prometheus request failed: ${message}`);
    }

    if (!response.ok) throw new Error(`Prometheus returned HTTP ${response.status}`);

    const envelope = (await response.json()) as PrometheusEnvelope<T>;
    if (envelope.status !== 'success' || envelope.data === undefined) {
      throw new Error(`Prometheus query failed: ${envelope.error ?? envelope.errorType ?? 'unknown error'}`);
    }
    return envelope.data;
  }
}
