import { SystemLogsController } from './system-logs.controller';
import type { LokiLogEntry } from '../services/loki-query.service';

const FROM = '2026-01-01T00:00:00.000Z';
const TO = '2026-01-01T01:00:00.000Z';

const entry = (overrides: Partial<LokiLogEntry> = {}): LokiLogEntry => ({
  timestamp: FROM,
  timestampNs: '1767225600000000000',
  message: 'log message',
  service: 'call-service',
  container: 'call-service-1',
  stream: 'stdout',
  level: 'info',
  labels: {
    service: 'call-service',
    container: 'call-service-1',
    stream: 'stdout',
  },
  ...overrides,
});

describe('SystemLogsController', () => {
  const loki = { range: jest.fn() };
  const metrics = { recordRpc: jest.fn() };
  const controller = new SystemLogsController(loki as never, metrics as never);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('finds older errors even when newer info logs would fill the source limit', async () => {
    loki.range.mockResolvedValue([
      entry({ level: 'error', message: 'database ERROR timeout' }),
    ]);

    const response = await controller.query({
      service: 'call-service',
      level: 'error',
      from: FROM,
      to: TO,
      limit: 20,
    });

    const calls = loki.range.mock.calls;
    expect(calls).toHaveLength(2);
    const queries = calls.map(([query]) => query as string);
    expect(queries[0]).toContain('|~');
    expect(queries[0]).toContain('stream!="stderr"');
    expect(queries[0]).toContain('FATAL|ERROR|EXCEPTION');
    expect(queries[1]).toContain('stream="stderr"');
    expect(
      queries.every((query) => query.includes('service="call-service"')),
    ).toBe(true);
    expect(
      calls.every(
        ([, from, to, limit]) => from === FROM && to === TO && limit === 21,
      ),
    ).toBe(true);
    expect(response.entries).toHaveLength(1);
    expect(response.entries[0].level).toBe('error');
  });

  it('keeps stderr in the error result even without an error token', async () => {
    loki.range.mockImplementation((query: string) =>
      Promise.resolve(
        query.includes('stream="stderr"')
          ? [
              entry({
                stream: 'stderr',
                level: 'error',
                message: 'request completed',
              }),
            ]
          : [],
      ),
    );

    const response = await controller.query({
      service: 'call-service',
      level: 'error',
      from: FROM,
      to: TO,
      limit: 20,
    });

    expect(response.entries).toHaveLength(1);
    expect(response.entries[0].stream).toBe('stderr');
    expect(response.entries[0].level).toBe('error');
  });

  it('keeps warn results out of error and stderr streams', async () => {
    loki.range.mockResolvedValue([
      entry({ level: 'warn', message: 'WARN retrying' }),
      entry({ level: 'info', message: 'INFO request completed' }),
    ]);

    const response = await controller.query({
      service: 'conversation-service',
      level: 'warn',
      from: FROM,
      to: TO,
      limit: 20,
    });

    const [query] = loki.range.mock.calls[0];
    expect(query).toContain('stream!="stderr"');
    expect(query).toContain('!~ "(?i)\\\\b(FATAL|ERROR|EXCEPTION)\\\\b"');
    expect(query).toContain('|~ "(?i)\\\\bWARN(?:ING)?\\\\b"');
    expect(response.entries.map((log) => log.level)).toEqual(['warn']);
  });

  it('filters debug logs without admitting info or warn messages', async () => {
    loki.range.mockResolvedValue([
      entry({ level: 'debug', message: 'DEBUG cache miss' }),
      entry({ level: 'warn', message: 'WARNING slow query' }),
      entry({ level: 'info', message: 'request completed' }),
    ]);

    const response = await controller.query({
      service: 'call-service',
      level: 'debug',
      from: FROM,
      to: TO,
      limit: 20,
    });

    const [query] = loki.range.mock.calls[0];
    expect(query).toContain('!~ "(?i)\\\\b(FATAL|ERROR|EXCEPTION)\\\\b"');
    expect(query).toContain('!~ "(?i)\\\\bWARN(?:ING)?\\\\b"');
    expect(query).toContain('|~ "(?i)\\\\b(DEBUG|VERBOSE)\\\\b"');
    expect(response.entries.map((log) => log.level)).toEqual(['debug']);
  });

  it('filters info logs in Loki without admitting error, warn, or debug messages', async () => {
    loki.range.mockResolvedValue([
      entry({ level: 'info', message: 'request completed' }),
      entry({ level: 'error', message: 'ERROR database failure' }),
      entry({ level: 'warn', message: 'WARNING retrying' }),
      entry({ level: 'debug', message: 'DEBUG cache miss' }),
    ]);

    const response = await controller.query({
      service: 'call-service',
      level: 'info',
      from: FROM,
      to: TO,
      limit: 20,
    });

    const [query] = loki.range.mock.calls[0];
    expect(query).toContain('stream!="stderr"');
    expect(query).toContain('!~ "(?i)\\\\b(FATAL|ERROR|EXCEPTION)\\\\b"');
    expect(query).toContain('!~ "(?i)\\\\bWARN(?:ING)?\\\\b"');
    expect(query).toContain('!~ "(?i)\\\\b(DEBUG|VERBOSE)\\\\b"');
    expect(response.entries.map((log) => log.level)).toEqual(['info']);
  });

  it('composes search with level and keeps a service-specific selector', async () => {
    loki.range.mockResolvedValue([
      entry({ level: 'error', message: 'ERROR timeout' }),
    ]);

    await controller.query({
      service: 'call-service',
      level: 'error',
      search: 'timeout',
      from: FROM,
      to: TO,
      limit: 20,
    });

    const queries = loki.range.mock.calls.map(([query]) => query as string);
    expect(queries.every((query) => query.includes('|= "timeout"'))).toBe(true);
    expect(
      queries.every(
        (query) => !query.includes('service="conversation-service"'),
      ),
    ).toBe(true);
    expect(
      queries.every((query) => query.includes('service="call-service"')),
    ).toBe(true);
  });

  it('uses limit plus one to report whether matching logs may continue', async () => {
    loki.range.mockResolvedValue(
      Array.from({ length: 21 }, (_, index) =>
        entry({
          timestampNs: String(1767225600000000000n + BigInt(index)),
          level: 'info',
        }),
      ),
    );

    const response = await controller.query({
      service: 'all',
      level: 'all',
      from: FROM,
      to: TO,
      limit: 20,
    });

    expect(loki.range).toHaveBeenCalledWith(
      expect.stringContaining('service=~'),
      FROM,
      TO,
      21,
    );
    expect(response.entries).toHaveLength(20);
    expect(response.mayHaveMore).toBe(true);
  });

  it('does not claim more results when the matching result set fits the limit', async () => {
    loki.range.mockResolvedValue(
      Array.from({ length: 20 }, () => entry({ level: 'info' })),
    );

    const response = await controller.query({
      service: 'all',
      level: 'all',
      from: FROM,
      to: TO,
      limit: 20,
    });

    expect(response.mayHaveMore).toBe(false);
  });
});
