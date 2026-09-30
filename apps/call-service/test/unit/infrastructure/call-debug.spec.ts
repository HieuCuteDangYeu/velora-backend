import {
  safeCallErrorCode,
  shortCallIdentifier,
} from '../../../src/infrastructure/gateways/call-debug';

describe('call runtime diagnostics', () => {
  it('hashes even short client-controlled identifiers before they reach logs', () => {
    const label = shortCallIdentifier('short-id');
    expect(label).toMatch(/^[a-f0-9]{12}$/);
    expect(label).toBe(shortCallIdentifier('short-id'));
    expect(label).not.toBe(shortCallIdentifier('other-id'));
    expect(label).not.toContain('short-id');
    expect(shortCallIdentifier(null)).toBe('unknown');
  });

  it('returns stable error categories without exposing native messages', () => {
    const error = new Error('native SDK contains private details');
    expect(safeCallErrorCode(error)).toBe('unknown_error');
    expect(safeCallErrorCode(new Error('Producer not found'))).toBe(
      'producer_error',
    );
    expect(safeCallErrorCode({ code: 'HTTP_404' })).toBe('http_404');
    expect(safeCallErrorCode({ code: 'answer-action-secret' })).toBe(
      'unknown_error',
    );
  });
});
