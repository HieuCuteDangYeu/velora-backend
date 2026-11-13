import {
  countPendingNotificationIntents,
  findDueNotificationIntents,
} from './notification-intent.reader';

const NOW = new Date('2026-10-09T00:00:00.000Z');
const id = '507f1f77bcf86cd799439011';

describe('Notification candidate discovery', () => {
  it('uses a typed, ordered, bounded range query and decodes BSON IDs', async () => {
    const message = {
      findRaw: jest.fn().mockResolvedValue([{ _id: { $oid: id } }]),
    };
    expect(
      await findDueNotificationIntents({ message } as never, NOW, 20),
    ).toEqual([{ id }]);
    expect(message.findRaw).toHaveBeenCalledWith({
      filter: {
        notificationNextAttemptAt: {
          $type: 'date',
          $lte: { $date: NOW.toISOString() },
        },
      },
      options: {
        sort: { notificationNextAttemptAt: 1, _id: 1 },
        limit: 20,
        projection: { _id: 1 },
      },
    });
  });

  it('accepts an empty due set', async () => {
    const message = { findRaw: jest.fn().mockResolvedValue([]) };
    expect(
      await findDueNotificationIntents({ message } as never, NOW, 20),
    ).toEqual([]);
  });

  it.each([
    null,
    {},
    [{ _id: id }],
    [{ _id: { $oid: 'not-an-object-id' } }],
    Array.from({ length: 21 }, () => ({ _id: { $oid: id } })),
  ])('rejects malformed or oversized results: %j', async (result) => {
    const message = { findRaw: jest.fn().mockResolvedValue(result) };
    await expect(
      findDueNotificationIntents({ message } as never, NOW, 20),
    ).rejects.toThrow();
  });

  it('propagates a failed query instead of reporting an empty backlog', async () => {
    const failure = new Error('Mongo unavailable');
    const message = { findRaw: jest.fn().mockRejectedValue(failure) };
    await expect(
      findDueNotificationIntents({ message } as never, NOW, 20),
    ).rejects.toBe(failure);
  });
});

describe('Notification backlog count', () => {
  it('counts pending intents with a date-typed range on the due-date index, not a null comparison', async () => {
    const message = {
      aggregateRaw: jest.fn().mockResolvedValue([{ pending: 12 }]),
    };
    expect(await countPendingNotificationIntents({ message } as never)).toBe(
      12,
    );
    // Prisma's `not: null` becomes $expr and scans every message; this range is
    // the shape the due-date read already uses on the index.
    expect(message.aggregateRaw).toHaveBeenCalledWith({
      pipeline: [
        {
          $match: {
            notificationNextAttemptAt: {
              $type: 'date',
              $lte: { $date: '9999-12-31T23:59:59.999Z' },
            },
          },
        },
        { $count: 'pending' },
      ],
    });
  });

  it('reads an empty result as no backlog, since $count returns no document then', async () => {
    const message = { aggregateRaw: jest.fn().mockResolvedValue([]) };
    expect(await countPendingNotificationIntents({ message } as never)).toBe(0);
  });

  it.each([
    [[{ pending: { $numberInt: '7' } }], 7],
    [[{ pending: { $numberLong: '2500' } }], 2500],
    [[{ pending: 0 }], 0],
  ])('accepts the count as %j', async (result, expected) => {
    const message = { aggregateRaw: jest.fn().mockResolvedValue(result) };
    expect(await countPendingNotificationIntents({ message } as never)).toBe(
      expected,
    );
  });

  it.each([
    null,
    {},
    [{ pending: -1 }],
    [{ pending: 1.5 }],
    [{ pending: 'many' }],
    [{ other: 1 }],
    [{ pending: 1 }, { pending: 2 }],
  ])('rejects a malformed result: %j', async (result) => {
    const message = { aggregateRaw: jest.fn().mockResolvedValue(result) };
    await expect(
      countPendingNotificationIntents({ message } as never),
    ).rejects.toThrow();
  });

  it('propagates a failed query instead of reporting an empty backlog', async () => {
    const failure = new Error('Mongo unavailable');
    const message = { aggregateRaw: jest.fn().mockRejectedValue(failure) };
    await expect(
      countPendingNotificationIntents({ message } as never),
    ).rejects.toBe(failure);
  });
});
