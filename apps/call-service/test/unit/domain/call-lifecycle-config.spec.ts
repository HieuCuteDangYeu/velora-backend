import {
  DEFAULT_CALL_NO_ANSWER_TIMEOUT_MS,
  getCallNoAnswerTimeoutMs,
  getSessionExpiryDate,
  getSessionRingTimeoutMs,
} from '../../../src/domain/call-lifecycle-config';

describe('call lifecycle configuration', () => {
  const originalTimeout = process.env.CALL_NO_ANSWER_TIMEOUT_MS;

  afterEach(() => {
    if (originalTimeout === undefined) {
      delete process.env.CALL_NO_ANSWER_TIMEOUT_MS;
    } else {
      process.env.CALL_NO_ANSWER_TIMEOUT_MS = originalTimeout;
    }
  });

  it.each(['0', '-1', 'not-a-number'])(
    'falls back to a valid server deadline for malformed timeout %s',
    (value) => {
      process.env.CALL_NO_ANSWER_TIMEOUT_MS = value;

      expect(getCallNoAnswerTimeoutMs()).toBe(
        DEFAULT_CALL_NO_ANSWER_TIMEOUT_MS,
      );
      expect(getSessionRingTimeoutMs(0)).toBe(
        DEFAULT_CALL_NO_ANSWER_TIMEOUT_MS,
      );
    },
  );

  it('keeps a valid persisted session deadline authoritative', () => {
    process.env.CALL_NO_ANSWER_TIMEOUT_MS = '30000';

    expect(getCallNoAnswerTimeoutMs()).toBe(30000);
    expect(getSessionRingTimeoutMs(1250.9)).toBe(1250);
  });

  it('reconstructs an invalid persisted expiry from the same ring deadline', () => {
    const now = new Date('2026-09-06T10:00:00.000Z');

    expect(
      getSessionExpiryDate(new Date('invalid'), 1250, now).toISOString(),
    ).toBe('2026-09-06T10:00:01.250Z');
  });
});
