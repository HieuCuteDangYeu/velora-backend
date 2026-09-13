import { ConfigService } from '@nestjs/config';
import { LokiQueryService, type LokiLogLevel } from './loki-query.service';

describe('LokiQueryService log classification', () => {
  const service = new LokiQueryService(
    new ConfigService({ LOKI_URL: 'http://loki:3100' }),
  );
  const inferLevel = (message: string, stream: string | null): LokiLogLevel =>
    (
      service as unknown as {
        inferLevel(message: string, stream: string | null): LokiLogLevel;
      }
    ).inferLevel(message, stream);

  it('keeps stderr classified as error even without an error token', () => {
    expect(inferLevel('request completed', 'stderr')).toBe('error');
  });

  it('uses the same token precedence as the Loki query filters', () => {
    expect(inferLevel('ERROR after WARNING', 'stdout')).toBe('error');
    expect(inferLevel('WARNING retrying', 'stdout')).toBe('warn');
    expect(inferLevel('VERBOSE cache miss', 'stdout')).toBe('debug');
    expect(inferLevel('request completed', 'stdout')).toBe('info');
  });
});
