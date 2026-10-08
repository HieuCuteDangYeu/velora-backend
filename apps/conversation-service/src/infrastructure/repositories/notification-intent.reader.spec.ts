import { findDueNotificationIntents } from './notification-intent.reader';

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
