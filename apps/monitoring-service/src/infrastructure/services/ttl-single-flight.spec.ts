import { KeyedTtlSingleFlight, TtlSingleFlight } from './ttl-single-flight';

describe('TtlSingleFlight', () => {
  it('shares an in-flight load and keeps a success for the ttl', async () => {
    let now = 1000;
    const flight = new TtlSingleFlight<number>(5000, () => now);
    let release!: (value: number) => void;
    const load = jest
      .fn()
      .mockImplementationOnce(
        () => new Promise<number>((resolve) => (release = resolve)),
      )
      .mockResolvedValue(2);

    const first = flight.get(load);
    now += 10_000; // an in-flight load never expires
    const second = flight.get(load);
    expect(load).toHaveBeenCalledTimes(1);

    release(1);
    await expect(Promise.all([first, second])).resolves.toEqual([1, 1]);

    now += 4999;
    await expect(flight.get(load)).resolves.toBe(1);
    now += 1;
    await expect(flight.get(load)).resolves.toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('never caches a failure', async () => {
    const flight = new TtlSingleFlight<number>(5000);
    const load = jest
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue(7);

    await expect(flight.get(load)).rejects.toThrow('down');
    await expect(flight.get(load)).resolves.toBe(7);
  });

  it('keeps one slot per key', async () => {
    const flight = new KeyedTtlSingleFlight<string>(5000);
    const load = jest.fn((key: string) => Promise.resolve(key));

    await flight.get('a', () => load('a'));
    await flight.get('b', () => load('b'));
    await flight.get('a', () => load('a'));
    expect(load).toHaveBeenCalledTimes(2);
  });
});
