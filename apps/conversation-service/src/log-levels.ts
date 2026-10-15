import type { LogLevel } from '@nestjs/common';

// Least to most important; enabling a level also enables everything after it.
const LEVELS: LogLevel[] = [
  'verbose',
  'debug',
  'log',
  'warn',
  'error',
  'fatal',
];
const DEFAULT_LEVEL: LogLevel = 'log';

/**
 * LOG_LEVEL=<level> keeps that level and everything more important. Unset or unrecognised
 * values mean "log": debug and verbose lines (one per message sent, around 1,400 lines/s at
 * 1000 messages/s) are not written unless asked for with LOG_LEVEL=debug or verbose.
 */
export function resolveLogLevels(value: string | null | undefined): LogLevel[] {
  const requested = (value ?? '').trim().toLowerCase();
  const start = LEVELS.indexOf(
    (LEVELS as string[]).includes(requested)
      ? (requested as LogLevel)
      : DEFAULT_LEVEL,
  );
  return LEVELS.slice(start);
}
