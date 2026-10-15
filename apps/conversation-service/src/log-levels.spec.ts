import { ConsoleLogger, Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { resolveLogLevels } from './log-levels';

describe('resolveLogLevels', () => {
  it.each([undefined, null, '', '   ', 'log', 'LOG', 'nonsense', 'info'])(
    'drops debug and verbose by default (%p)',
    (value) => {
      expect(resolveLogLevels(value)).toEqual([
        'log',
        'warn',
        'error',
        'fatal',
      ]);
    },
  );

  it.each([
    ['verbose', ['verbose', 'debug', 'log', 'warn', 'error', 'fatal']],
    ['debug', ['debug', 'log', 'warn', 'error', 'fatal']],
    [' DEBUG ', ['debug', 'log', 'warn', 'error', 'fatal']],
    ['warn', ['warn', 'error', 'fatal']],
    ['error', ['error', 'fatal']],
    ['fatal', ['fatal']],
  ])(
    'LOG_LEVEL=%p keeps that level and everything above it',
    (value, expected) => {
      expect(resolveLogLevels(value)).toEqual(expected);
    },
  );
});

describe('Nest logger with the resolved levels', () => {
  afterEach(() => jest.restoreAllMocks());

  const write = () =>
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

  it('does not print debug lines by default but still prints log, warn and error', () => {
    const out = write();
    const err = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const logger = new ConsoleLogger('Test', {
      logLevels: resolveLogLevels(undefined),
    });

    logger.debug('Message saved to conversation');
    logger.verbose('details');
    expect(out).not.toHaveBeenCalled();

    logger.log('started');
    logger.warn('careful');
    logger.error('broken');
    expect(out.mock.calls.length + err.mock.calls.length).toBe(3);
  });

  it('prints debug lines again with LOG_LEVEL=debug', () => {
    const out = write();
    const logger = new ConsoleLogger('Test', {
      logLevels: resolveLogLevels('debug'),
    });

    logger.debug('Message saved to conversation');

    expect(out).toHaveBeenCalledTimes(1);
    expect(String(out.mock.calls[0][0])).toContain(
      'Message saved to conversation',
    );
  });
});

describe('Application bootstrap with LOG_LEVEL', () => {
  @Module({})
  class EmptyModule {}

  afterEach(() => jest.restoreAllMocks());

  it.each([
    [undefined, 0],
    ['debug', 1],
  ])(
    'passes the levels to the application logger (LOG_LEVEL=%p, debug lines: %d)',
    async (level, expected) => {
      const out = jest
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);
      const app = await NestFactory.create(EmptyModule, {
        logger: resolveLogLevels(level),
      });
      out.mockClear();

      new Logger('SendMessageUseCase').debug(
        'Message abc saved to conversation def',
      );

      expect(
        out.mock.calls.filter((call) =>
          String(call[0]).includes('saved to conversation'),
        ),
      ).toHaveLength(expected);
      await app.close();
    },
  );
});
