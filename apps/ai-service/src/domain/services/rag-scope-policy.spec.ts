import { readRagScopeMode } from './rag-scope-policy';

const config = (values: Record<string, string> = {}) => ({
  get: <T = string>(key: string) => values[key] as T | undefined,
});

describe('readRagScopeMode', () => {
  it('keeps the assistant on topic unless told otherwise', () => {
    expect(readRagScopeMode(config())).toBe('enforce');
    expect(readRagScopeMode(undefined)).toBe('enforce');
    expect(readRagScopeMode(config({ AI_SCOPE_MODE: 'nonsense' }))).toBe(
      'enforce',
    );
  });

  it('allows switching the restriction off', () => {
    expect(readRagScopeMode(config({ AI_SCOPE_MODE: 'off' }))).toBe('off');
    expect(readRagScopeMode(config({ AI_SCOPE_MODE: ' OFF ' }))).toBe('off');
  });
});
