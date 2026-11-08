import { normalizeIp, resolveClientIp } from './client-ip';

describe('resolveClientIp', () => {
  it('uses req.ip and strips the IPv4-mapped prefix', () => {
    expect(resolveClientIp({ ip: '::ffff:203.0.113.7' })).toBe('203.0.113.7');
  });

  it('prefers the configured trusted header, first value only', () => {
    expect(
      resolveClientIp(
        {
          ip: '10.0.0.1',
          headers: { 'cf-connecting-ip': '198.51.100.9, 1.1.1.1' },
        },
        'CF-Connecting-IP',
      ),
    ).toBe('198.51.100.9');
  });

  it('ignores the header when it is not configured', () => {
    expect(
      resolveClientIp({
        ip: '10.0.0.1',
        headers: { 'cf-connecting-ip': '1.1.1.1' },
      }),
    ).toBe('10.0.0.1');
  });

  it('falls back to the socket and then to unknown', () => {
    expect(resolveClientIp({ socket: { remoteAddress: '192.0.2.5' } })).toBe(
      '192.0.2.5',
    );
    expect(resolveClientIp({})).toBe('unknown');
  });

  it('buckets IPv6 clients by /64', () => {
    expect(normalizeIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe(
      normalizeIp('2001:db8:1:2::1'),
    );
    expect(normalizeIp('2001:db8:1:2::1')).not.toBe(
      normalizeIp('2001:db8:1:3::1'),
    );
  });
});
