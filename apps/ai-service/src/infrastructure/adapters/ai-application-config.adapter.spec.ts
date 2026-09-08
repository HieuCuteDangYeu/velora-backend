import { AiApplicationConfigAdapter } from './ai-application-config.adapter';

describe('AiApplicationConfigAdapter completion budgets', () => {
  it('uses the empirically selected role defaults', () => {
    const config = { get: jest.fn().mockReturnValue(undefined) };
    const adapter = new AiApplicationConfigAdapter(config as never);

    expect(adapter.maxCompletionTokens('ROUTER')).toBe(2_048);
    expect(adapter.maxCompletionTokens('RETRIEVAL_PLANNER')).toBe(512);
    expect(adapter.maxCompletionTokens('ANSWER')).toBe(1_536);
    expect(adapter.maxCompletionTokens('VERIFIER')).toBe(1_024);
    expect(adapter.maxCompletionTokens('VERIFIER_ESCALATION')).toBe(1_024);
  });

  it('reads independent primary and escalation budgets', () => {
    const values: Record<string, string> = {
      AI_VERIFIER_MAX_TOKENS: '700',
      AI_VERIFIER_ESCALATION_MAX_TOKENS: '1200',
    };
    const config = {
      get: jest.fn((key: string) => values[key]),
    };
    const adapter = new AiApplicationConfigAdapter(config as never);

    expect(adapter.maxCompletionTokens('VERIFIER')).toBe(700);
    expect(adapter.maxCompletionTokens('VERIFIER_ESCALATION')).toBe(1_200);
  });

  it.each(['127', '4097', 'not-a-number'])(
    'rejects invalid configured budgets (%s)',
    (value) => {
      const config = { get: jest.fn().mockReturnValue(value) };
      const adapter = new AiApplicationConfigAdapter(config as never);

      expect(() => adapter.maxCompletionTokens('VERIFIER')).toThrow(
        'Invalid AI_VERIFIER_MAX_TOKENS',
      );
    },
  );

  it.each([
    ['ROUTER', 'AI_ROUTER_MAX_TOKENS', '384', 384],
    ['ANSWER', 'AI_ANSWER_MAX_TOKENS', '1800', 1_800],
    ['CITATION_ATTRIBUTION', 'AI_CITATION_MAX_TOKENS', '800', 800],
  ] as const)(
    'reads the %s role budget independently',
    (role, key, value, expected) => {
      const config = {
        get: jest.fn((requested: string) =>
          requested === key ? value : undefined,
        ),
      };
      const adapter = new AiApplicationConfigAdapter(config as never);
      expect(adapter.maxCompletionTokens(role)).toBe(expected);
    },
  );

  it.each([8_000, 20_000, 45_000, 60_000, 120_000])(
    'honors validated role timeout %i',
    (timeout) => {
      const config = {
        get: jest.fn((key: string) =>
          key === 'AI_ROUTER_TIMEOUT_MS' ? String(timeout) : undefined,
        ),
      };
      const adapter = new AiApplicationConfigAdapter(config as never);
      expect(adapter.timeoutMs('ROUTER')).toBe(timeout);
    },
  );

  it.each(['120001', 'Infinity', 'not-a-number'])(
    'rejects unbounded role timeout %s',
    (timeout) => {
      const config = {
        get: jest.fn((key: string) =>
          key === 'AI_ROUTER_TIMEOUT_MS' ? timeout : undefined,
        ),
      };
      const adapter = new AiApplicationConfigAdapter(config as never);
      expect(() => adapter.timeoutMs('ROUTER')).toThrow(
        'Invalid AI_ROUTER_TIMEOUT_MS',
      );
    },
  );
});
