import { TtlPromiseCache } from './ttl-promise-cache';

describe('TtlPromiseCache', () => {
  it('shares one load between concurrent callers and expires after the ttl', async () => {
    let now = 1_000;
    const cache = new TtlPromiseCache<number>(100, 10, () => now);
    const load = jest.fn().mockResolvedValue(7);

    await Promise.all([cache.get('a', load), cache.get('a', load)]);
    expect(load).toHaveBeenCalledTimes(1);

    now += 99;
    await cache.get('a', load);
    expect(load).toHaveBeenCalledTimes(1);

    now += 2;
    await cache.get('a', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not keep a failed load', async () => {
    const cache = new TtlPromiseCache<number>(1_000);
    const load = jest
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue(1);

    await expect(cache.get('k', load)).rejects.toThrow('down');
    await expect(cache.get('k', load)).resolves.toBe(1);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps keys apart and stays within its size bound', async () => {
    const cache = new TtlPromiseCache<string>(1_000, 2);
    const load = (value: string) => jest.fn().mockResolvedValue(value);
    const a = load('a');

    await cache.get('a', a);
    await cache.get('b', load('b'));
    await cache.get('c', load('c'));
    await cache.get('a', a);

    expect(a).toHaveBeenCalledTimes(2);
  });

  it('can refuse to remember chosen results', async () => {
    const cache = new TtlPromiseCache<boolean>(1_000, 10, Date.now, (v) => v);
    const load = jest.fn().mockResolvedValue(false);

    await cache.get('k', load);
    await cache.get('k', load);

    expect(load).toHaveBeenCalledTimes(2);
  });
});
