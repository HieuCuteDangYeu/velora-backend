import {
  safeCallErrorCode,
  shortCallIdentifier,
} from '../../../src/infrastructure/gateways/call-debug';

describe('call runtime diagnostics', () => {
  it('shortens identifiers before they reach logs', () => {
    expect(shortCallIdentifier('1234567890abcdef')).toBe('12345678…def');
    expect(shortCallIdentifier('short-id')).toBe('short-id');
  });

  it('returns stable error categories without exposing native messages', () => {
    const error = new Error('native SDK contains private details');
    expect(safeCallErrorCode(error)).toBe('unknown_error');
    expect(safeCallErrorCode(new Error('Producer not found'))).toBe(
      'producer_error',
    );
    expect(safeCallErrorCode({ code: 'HTTP_404' })).toBe('http_404');
  });
});
