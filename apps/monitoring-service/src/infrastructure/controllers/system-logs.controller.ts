import { Controller } from '@nestjs/common';
import { MessagePattern, Payload, RpcException } from '@nestjs/microservices';
import { PrometheusMetricsService } from '../metrics/prometheus-metrics.service';
import {
  LokiQueryService,
  type LokiLogEntry,
  type LokiLogLevel,
} from '../services/loki-query.service';

const ALLOWED_LOG_SERVICES = new Set([
  'api-gateway',
  'nginx',
  'user-service',
  'friend-service',
  'auth-service',
  'media-service',
  'media-processing-service',
  'media-processing-long-service',
  'reel-indexing-service',
  'reel-indexing-long-service',
  'content-service',
  'payment-service',
  'mail-service',
  'conversation-service',
  'call-service',
  'monitoring-service',
  'notification-service',
  'ai-service',
  'rag-embedding',
  'rag-reranker',
  'rag-vision',
  'rag-eval',
  'rabbitmq',
  'prometheus',
  'node-exporter',
  'grafana',
  'loki',
  'alloy',
]);

const ALLOWED_LOG_LEVELS = new Set(['all', 'error', 'warn', 'info', 'debug']);
const MAX_LOG_RANGE_MS = 24 * 60 * 60 * 1000;
const ERROR_LOG_PATTERN = String.raw`(?i)\b(FATAL|ERROR|EXCEPTION)\b`;
const WARN_LOG_PATTERN = String.raw`(?i)\bWARN(?:ING)?\b`;
const DEBUG_LOG_PATTERN = String.raw`(?i)\b(DEBUG|VERBOSE)\b`;

type LogsPayload = {
  service?: unknown;
  level?: unknown;
  search?: unknown;
  from?: unknown;
  to?: unknown;
  limit?: unknown;
};

type ParsedLogsQuery = {
  service: string;
  level: 'all' | LokiLogLevel;
  search: string;
  from: string;
  to: string;
  limit: number;
};

@Controller()
export class SystemLogsController {
  constructor(
    private readonly loki: LokiQueryService,
    private readonly metrics: PrometheusMetricsService,
  ) {}

  @MessagePattern('system.logs.query')
  async query(@Payload() payload: LogsPayload) {
    return this.measure('system.logs.query', async () => {
      const parsed = this.parsePayload(payload);
      const logQlQueries = this.buildLogQl(parsed);
      // The LogQL level filter is applied before Loki's limit. Ask for one
      // extra matching entry so mayHaveMore reflects matching logs, not noise.
      const sourceLimit = parsed.limit + 1;

      try {
        const sourceEntries = await Promise.all(
          logQlQueries.map((logQl) =>
            this.loki.range(logQl, parsed.from, parsed.to, sourceLimit),
          ),
        );
        const entries = this.mergeEntries(sourceEntries.flat());
        const filtered = entries.filter(
          (entry) => parsed.level === 'all' || entry.level === parsed.level,
        );

        return {
          generatedAt: new Date().toISOString(),
          source: 'loki' as const,
          query: parsed,
          entries: filtered.slice(0, parsed.limit),
          mayHaveMore: filtered.length > parsed.limit,
        };
      } catch (error) {
        throw this.lokiError(error);
      }
    });
  }

  private parsePayload(payload: LogsPayload): ParsedLogsQuery {
    const service =
      typeof payload?.service === 'string' ? payload.service.trim() : 'all';
    const level =
      typeof payload?.level === 'string' ? payload.level.trim() : 'all';
    const search =
      typeof payload?.search === 'string' ? payload.search.trim() : '';
    const from = payload?.from;
    const to = payload?.to;
    const limit = Number(payload?.limit ?? 200);

    if (service !== 'all' && !ALLOWED_LOG_SERVICES.has(service)) {
      throw new RpcException({
        statusCode: 400,
        message: `service must be all or one of: ${Array.from(ALLOWED_LOG_SERVICES).join(', ')}`,
      });
    }

    if (!ALLOWED_LOG_LEVELS.has(level)) {
      throw new RpcException({
        statusCode: 400,
        message: `level must be one of: ${Array.from(ALLOWED_LOG_LEVELS).join(', ')}`,
      });
    }

    if (search.length > 200) {
      throw new RpcException({
        statusCode: 400,
        message: 'search cannot exceed 200 characters',
      });
    }

    if (typeof from !== 'string' || typeof to !== 'string') {
      throw new RpcException({
        statusCode: 400,
        message: 'from and to are required ISO timestamps',
      });
    }

    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
      throw new RpcException({
        statusCode: 400,
        message: 'from and to must define a valid increasing time range',
      });
    }

    if (toMs - fromMs > MAX_LOG_RANGE_MS) {
      throw new RpcException({
        statusCode: 400,
        message: 'log query range cannot exceed 24 hours',
      });
    }

    if (!Number.isInteger(limit) || limit < 20 || limit > 500) {
      throw new RpcException({
        statusCode: 400,
        message: 'limit must be an integer between 20 and 500',
      });
    }

    return {
      service,
      level: level as ParsedLogsQuery['level'],
      search,
      from,
      to,
      limit,
    };
  }

  private buildLogQl(query: ParsedLogsQuery): string[] {
    const selector =
      query.service === 'all'
        ? `{service=~"${Array.from(ALLOWED_LOG_SERVICES)
            .map((service) => service.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('|')}"}`
        : `{service=${JSON.stringify(query.service)}}`;

    const levelQueries = this.buildLevelLogQl(selector, query.level);
    const queries = levelQueries.map((levelQuery) => {
      const withSearch = query.search
        ? this.appendSearch(levelQuery, query.search)
        : levelQuery;
      return withSearch;
    });

    return queries;
  }

  private buildLevelLogQl(
    selector: string,
    level: ParsedLogsQuery['level'],
  ): string[] {
    if (level === 'all') return [selector];

    const nonStderrSelector = this.withStreamMatcher(selector, '!=', 'stderr');

    if (level === 'error') {
      const messageErrors = this.lineFilter(
        nonStderrSelector,
        '|~',
        ERROR_LOG_PATTERN,
      );
      const stderr = this.withStreamMatcher(selector, '=', 'stderr');
      return [messageErrors, stderr];
    }

    const withoutErrors = this.lineFilter(
      nonStderrSelector,
      '!~',
      ERROR_LOG_PATTERN,
    );
    if (level === 'warn') {
      return [this.lineFilter(withoutErrors, '|~', WARN_LOG_PATTERN)];
    }

    const withoutWarnings = this.lineFilter(
      withoutErrors,
      '!~',
      WARN_LOG_PATTERN,
    );
    if (level === 'debug') {
      return [this.lineFilter(withoutWarnings, '|~', DEBUG_LOG_PATTERN)];
    }

    return [this.lineFilter(withoutWarnings, '!~', DEBUG_LOG_PATTERN)];
  }

  private lineFilter(selector: string, operator: '|~' | '!~', pattern: string) {
    return `${selector} ${operator} ${JSON.stringify(pattern)}`;
  }

  private withStreamMatcher(
    selector: string,
    operator: '=' | '!=',
    stream: string,
  ) {
    return `${selector.slice(0, -1)},stream${operator}${JSON.stringify(stream)}}`;
  }

  private appendSearch(query: string, search: string) {
    return `${query} |= ${JSON.stringify(search)}`;
  }

  private mergeEntries(entries: LokiLogEntry[]) {
    const unique = new Map<string, LokiLogEntry>();
    for (const entry of entries) {
      const key = JSON.stringify([
        entry.timestampNs,
        entry.service,
        entry.container,
        entry.stream,
        entry.message,
      ]);
      unique.set(key, entry);
    }

    return Array.from(unique.values()).sort((left, right) =>
      left.timestampNs === right.timestampNs
        ? 0
        : BigInt(left.timestampNs) > BigInt(right.timestampNs)
          ? -1
          : 1,
    );
  }

  private lokiError(error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Loki query failed';
    return new RpcException({
      statusCode: 503,
      message,
    });
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
      const durationSeconds =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      this.metrics.recordRpc(pattern, status, durationSeconds);
    }
  }
}
