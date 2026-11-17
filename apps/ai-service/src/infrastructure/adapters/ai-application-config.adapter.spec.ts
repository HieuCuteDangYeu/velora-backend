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

describe('AiApplicationConfigAdapter subtitle translation role', () => {
  const adapterWith = (values: Record<string, string>) =>
    new AiApplicationConfigAdapter({
      get: jest.fn((key: string) => values[key]),
    } as never);

  it('uses its own model when configured', () => {
    expect(
      adapterWith({
        AI_SUBTITLE_TRANSLATION_MODEL: ' translator ',
        AI_ANSWER_MODEL: 'answerer',
      }).model('SUBTITLE_TRANSLATION'),
    ).toBe('translator');
  });

  it('falls back to the answer model so an unset variable cannot stop startup', () => {
    const adapter = adapterWith({ AI_ANSWER_MODEL: 'answerer' });
    expect(adapter.model('SUBTITLE_TRANSLATION')).toBe('answerer');
  });

  it('still fails clearly when neither model is configured', () => {
    expect(() => adapterWith({}).model('SUBTITLE_TRANSLATION')).toThrow(
      'Missing required AI configuration: AI_ANSWER_MODEL',
    );
  });

  it('allows a long generation by default and a bounded override', () => {
    expect(adapterWith({}).timeoutMs('SUBTITLE_TRANSLATION')).toBe(90_000);
    expect(
      adapterWith({ AI_SUBTITLE_TRANSLATION_TIMEOUT_MS: '45000' }).timeoutMs(
        'SUBTITLE_TRANSLATION',
      ),
    ).toBe(45_000);
    expect(adapterWith({}).maxCompletionTokens('SUBTITLE_TRANSLATION')).toBe(
      2_048,
    );
  });
});
