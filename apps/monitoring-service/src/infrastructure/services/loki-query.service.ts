import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type LokiStreamResult = {
  stream: Record<string, string>;
  values: Array<[string, string]>;
};

type LokiSuccessResponse = {
  status: 'success';
  data: {
    resultType: string;
    result: LokiStreamResult[];
  };
};

type LokiErrorResponse = {
  status: 'error';
  errorType?: string;
  error?: string;
};

export type LokiLogLevel = 'error' | 'warn' | 'debug' | 'info';

export type LokiLogEntry = {
  timestamp: string;
  timestampNs: string;
  message: string;
  service: string;
  container: string | null;
  stream: string | null;
  level: LokiLogLevel;
  labels: Record<string, string>;
};

@Injectable()
export class LokiQueryService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(configService: ConfigService) {
    this.baseUrl = (
      configService.get<string>('LOKI_URL') || 'http://loki:3100'
    ).replace(/\/$/, '');
    this.timeoutMs = Number(
      configService.get<string>('LOKI_QUERY_TIMEOUT_MS') || 4000,
    );
  }

  async range(
    query: string,
    from: string,
    to: string,
    limit: number,
  ): Promise<LokiLogEntry[]> {
    const url = new URL(`${this.baseUrl}/loki/api/v1/query_range`);
    url.searchParams.set('query', query);
    url.searchParams.set('start', this.toNanoseconds(from));
    url.searchParams.set('end', this.toNanoseconds(to));
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('direction', 'backward');

    const envelope = await this.request<LokiSuccessResponse | LokiErrorResponse>(
      url,
    );

    if (envelope.status !== 'success') {
      throw new Error(
        `Loki query failed${envelope.errorType ? ` (${envelope.errorType})` : ''}: ${
          envelope.error || 'unknown error'
        }`,
      );
    }

    if (envelope.data.resultType !== 'streams') {
      throw new Error(
        `Loki returned unsupported result type: ${envelope.data.resultType}`,
      );
    }

    return envelope.data.result
      .flatMap(({ stream, values }) =>
        values.map(([timestampNs, rawMessage]) => {
          const message = this.stripAnsi(rawMessage);
          const streamName = stream.stream || null;

          return {
            timestamp: this.nanosecondsToIso(timestampNs),
            timestampNs,
            message,
            service: stream.service || 'unknown',
            container: stream.container || null,
            stream: streamName,
            level: this.inferLevel(message, streamName),
            labels: stream,
          } satisfies LokiLogEntry;
        }),
      )
      .sort((left, right) =>
        left.timestampNs === right.timestampNs
          ? 0
          : BigInt(left.timestampNs) > BigInt(right.timestampNs)
            ? -1
            : 1,
      );
  }

  private toNanoseconds(value: string): string {
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds)) {
      throw new Error(`Invalid Loki timestamp: ${value}`);
    }

    return (BigInt(milliseconds) * 1_000_000n).toString();
  }

  private nanosecondsToIso(timestampNs: string): string {
    try {
      const milliseconds = Number(BigInt(timestampNs) / 1_000_000n);
      return new Date(milliseconds).toISOString();
    } catch {
      return new Date(0).toISOString();
    }
  }

  private stripAnsi(value: string): string {
    return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
  }

  private inferLevel(message: string, stream: string | null): LokiLogLevel {
    if (stream === 'stderr' || /\b(FATAL|ERROR|EXCEPTION)\b/i.test(message)) {
      return 'error';
    }
    if (/\bWARN(?:ING)?\b/i.test(message)) {
      return 'warn';
    }
    if (/\b(DEBUG|VERBOSE)\b/i.test(message)) {
      return 'debug';
    }
    return 'info';
  }

  private async request<T>(url: URL): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Error(
        `Loki request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        `Loki returned HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`,
      );
    }

    try {
      return JSON.parse(body) as T;
    } catch {
      throw new Error('Loki returned invalid JSON');
    }
  }
}
