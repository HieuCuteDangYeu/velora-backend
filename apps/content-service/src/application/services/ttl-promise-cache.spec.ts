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

  describe('refresh ahead', () => {
    const flush = () => new Promise((resolve) => setImmediate(resolve));

    it('serves the cached value and refreshes once in the background near expiry', async () => {
      let now = 1_000;
      const cache = new TtlPromiseCache<number>(
        100,
        10,
        () => now,
        () => true,
        30,
      );
      const load = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);

      await expect(cache.get('k', load)).resolves.toBe(1);

      now += 60; // 40 ms left: outside the refresh window
      await expect(cache.get('k', load)).resolves.toBe(1);
      expect(load).toHaveBeenCalledTimes(1);

      now += 20; // 20 ms left: inside the window
      // Two callers in the same tick both get the cached value; only one refresh starts.
      await expect(
        Promise.all([cache.get('k', load), cache.get('k', load)]),
      ).resolves.toEqual([1, 1]);
      expect(load).toHaveBeenCalledTimes(2);

      await flush();
      now += 50; // past the first entry's expiry; the refreshed entry lives on
      await expect(cache.get('k', load)).resolves.toBe(2);
      expect(load).toHaveBeenCalledTimes(2);
    });

    it('keeps the old entry until it expires when the refresh fails', async () => {
      let now = 1_000;
      const cache = new TtlPromiseCache<number>(
        100,
        10,
        () => now,
        () => true,
        30,
      );
      const load = jest
        .fn()
        .mockResolvedValueOnce(1)
        .mockRejectedValueOnce(new Error('down'))
        .mockResolvedValue(3);

      await cache.get('k', load);
      now += 80;
      await expect(cache.get('k', load)).resolves.toBe(1);
      await flush();

      // The failed refresh did not extend or replace anything: still the old value...
      await expect(cache.get('k', load)).resolves.toBe(1);
      // ...and once it has expired, the next caller loads a new one.
      now += 30;
      await expect(cache.get('k', load)).resolves.toBe(3);
    });

    it('does nothing extra when refresh ahead is off', async () => {
      let now = 1_000;
      const cache = new TtlPromiseCache<number>(100, 10, () => now);
      const load = jest.fn().mockResolvedValue(1);

      await cache.get('k', load);
      now += 95;
      await cache.get('k', load);

      expect(load).toHaveBeenCalledTimes(1);
    });
  });
});
