import { Logger } from '@nestjs/common';
import {
  stressFixtureNamespace,
  StressMessageTiming,
} from './stress-message-timing';

const namespace = 'mu-0123456789ab';
const uuid = '11111111-1111-4111-8111-111111111111';
const id = `${namespace}-${uuid}-load-${uuid}`;
const receivedAt = '2026-10-11T00:00:00.000Z';

describe('Bounded stress timing', () => {
  let records: {
    clientMessageId: string;
    elapsedMs: Record<string, number>;
    outcome: string;
  }[];
  beforeEach(() => {
    records = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((value: string) => {
      records.push(JSON.parse(value) as (typeof records)[number]);
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('recognizes fixture email only with the complete reserved domain', () => {
    expect(
      stressFixtureNamespace(`${namespace}.001@velora-stress.invalid`),
    ).toBe(namespace);
    expect(
      stressFixtureNamespace(
        `${namespace}.001@velora-stress.invalid.example.org`,
      ),
    ).toBeUndefined();
    expect(stressFixtureNamespace('regular@example.org')).toBeUndefined();
  });

  it.each([undefined, 'mu-ffffffffffff', 'user supplied namespace'])(
    'does not trace unverified or mismatched namespace %s',
    async (value) => {
      const timing = new StressMessageTiming();
      await expect(
        timing.run(value, id, process.hrtime.bigint(), receivedAt, async () => {
          await Promise.resolve();
          timing.mark('ackSubmitted');
          timing.report('ack_submitted');
          return 42;
        }),
      ).resolves.toBe(42);
      expect(records).toHaveLength(0);
    },
  );

  it('excludes probes and arbitrary IDs and retains only stage metadata', async () => {
    await Promise.resolve();
    const timing = new StressMessageTiming();
    for (const value of [
      id.replace('-load-', '-preflight-'),
      'private message body',
    ]) {
      await timing.run(
        namespace,
        value,
        process.hrtime.bigint(),
        receivedAt,
        () => Promise.resolve(timing.report('failed')),
      );
    }
    expect(records).toHaveLength(0);
    await timing.run(
      namespace,
      id,
      process.hrtime.bigint(),
      receivedAt,
      async () => {
        await Promise.resolve();
        timing.mark('queued');
        timing.mark('transactionStarted');
        timing.mark('transactionResolved');
        timing.mark('ackSubmitted');
        timing.report('ack_submitted');
        timing.report('failed');
      },
    );
    expect(records).toHaveLength(1);
    expect(Object.keys(records[0]).sort()).toEqual([
      'clientMessageId',
      'elapsedMs',
      'outcome',
      'receivedAt',
      'type',
    ]);
    expect(Object.keys(records[0].elapsedMs)).toEqual([
      'queued',
      'transactionStarted',
      'transactionResolved',
      'ackSubmitted',
    ]);
    expect(records[0].elapsedMs.ackSubmitted).toBeGreaterThanOrEqual(
      records[0].elapsedMs.transactionResolved,
    );
  });

  it('isolates concurrent requests, including promise chains queued behind another request', async () => {
    await Promise.resolve();
    const timing = new StressMessageTiming();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const second = id.replace(/11111111$/, '22222222');
    const first = timing.run(
      namespace,
      id,
      process.hrtime.bigint(),
      receivedAt,
      async () => {
        await Promise.resolve();
        timing.mark('queued');
        await barrier;
        timing.mark('ackSubmitted');
        timing.report('ack_submitted');
      },
    );
    await timing.run(
      namespace,
      second,
      process.hrtime.bigint(),
      receivedAt,
      async () => {
        await Promise.resolve();
        timing.mark('transactionResolved');
        timing.report('failed');
        release();
      },
    );
    await first;
    expect(records.find((r) => r.clientMessageId === id)?.elapsedMs).toEqual({
      queued: expect.any(Number),
      ackSubmitted: expect.any(Number),
    });
    expect(
      records.find((r) => r.clientMessageId === second)?.elapsedMs,
    ).toEqual({ transactionResolved: expect.any(Number) });
    timing.report('failed');
    expect(records).toHaveLength(2);
  });

  it('caps accepted traces and preserves errors and logger failures', async () => {
    await Promise.resolve();
    const timing = new StressMessageTiming(1);
    const error = new Error('private error');
    await expect(
      timing.run(
        namespace,
        id,
        process.hrtime.bigint(),
        receivedAt,
        async () => {
          await Promise.resolve();
          timing.report('failed');
          throw error;
        },
      ),
    ).rejects.toBe(error);
    await timing.run(namespace, id, process.hrtime.bigint(), receivedAt, () =>
      Promise.resolve(timing.report('failed')),
    );
    expect(records).toHaveLength(1);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {
      throw error;
    });
    const other = new StressMessageTiming();
    await expect(
      other.run(
        namespace,
        id,
        process.hrtime.bigint(),
        receivedAt,
        async () => {
          await Promise.resolve();
          other.report('ack_submitted');
          return 42;
        },
      ),
    ).resolves.toBe(42);
  });
});
