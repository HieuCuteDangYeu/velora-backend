import { ThrottledWarn } from './throttled-warn';

describe('ThrottledWarn', () => {
  const create = (intervalMs = 10_000) => {
    let now = 1_000_000;
    const logger = { warn: jest.fn() };
    const throttled = new ThrottledWarn(logger, intervalMs, () => now);
    return {
      logger,
      throttled,
      advance: (ms: number) => {
        now += ms;
      },
    };
  };

  it('logs the first warning at once', () => {
    const { throttled, logger } = create();

    throttled.warn('slow', 'lookup slow');

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('lookup slow');
  });

  it('drops repeats inside the interval and counts them in the next line', () => {
    const { throttled, logger, advance } = create();

    throttled.warn('slow', 'first');
    for (let i = 0; i < 5; i++) {
      advance(1_000);
      throttled.warn('slow', `repeat ${i}`);
    }
    expect(logger.warn).toHaveBeenCalledTimes(1);

    advance(5_000);
    throttled.warn('slow', 'later');

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenLastCalledWith(
      'later (+5 similar in the last 10s)',
    );
  });

  it('does not add a count when nothing was dropped', () => {
    const { throttled, logger, advance } = create();

    throttled.warn('slow', 'first');
    advance(20_000);
    throttled.warn('slow', 'second');

    expect(logger.warn).toHaveBeenLastCalledWith('second');
  });

  it('throttles each key on its own', () => {
    const { throttled, logger } = create();

    throttled.warn('a', 'message a');
    throttled.warn('b', 'message b');
    throttled.warn('a', 'message a again');

    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
