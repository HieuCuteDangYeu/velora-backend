import { Conversation } from '../../domain/entities/conversation.entity';
import { MessageNotificationOutboxWorker } from './message-notification-outbox.worker';

const NOW = new Date('2026-10-07T00:00:00.000Z');
const makeRecord = (index = 1) => ({
  id: index.toString(16).padStart(24, '0'),
  conversationId: '507f1f77bcf86cd799439011',
  senderId: 'sender',
  clientMessageId: `client-${index}`,
  content: 'encrypted:hello',
  type: 'text',
  signalType: 0,
  media: null,
  metadata: null,
  registrationId: null,
  isRecalled: false,
  recalledAt: null,
  replyToId: null,
  replyPreview: null,
  reactions: null,
  readBy: [],
  createdAt: NOW,
  notificationRecipientIds: ['member', 'removed'],
  notificationNextAttemptAt: NOW as Date | null,
  notificationClaimId: null as string | null,
  notificationAttemptCount: 0,
});

const makeHarness = (records = [makeRecord()]) => {
  let conversation: Record<string, unknown> | null = {
    id: '507f1f77bcf86cd799439011',
    creatorId: 'sender',
    participantIds: ['sender', 'member', 'new-member'],
    isGroup: true,
    name: 'Group',
    picture: null,
    memberJoinedAt: null,
    lastMessage: 'hello',
    lastMessageAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const message = {
    findRaw: jest.fn(
      ({
        filter,
        options,
      }: {
        filter: { notificationNextAttemptAt: { $lte: { $date: string } } };
        options: { limit: number };
      }) => {
        const now = new Date(filter.notificationNextAttemptAt.$lte.$date);
        const due = records
          .filter(
            (r) =>
              r.notificationNextAttemptAt instanceof Date &&
              r.notificationNextAttemptAt <= now,
          )
          .sort(
            (a, b) =>
              a.notificationNextAttemptAt!.getTime() -
                b.notificationNextAttemptAt!.getTime() ||
              a.id.localeCompare(b.id),
          );
        return Promise.resolve(
          due.slice(0, options.limit).map(({ id }) => ({ _id: { $oid: id } })),
        );
      },
    ),
    aggregateRaw: jest.fn(
      ({
        pipeline,
      }: {
        pipeline: {
          $match?: { _id: { $oid: string }; notificationClaimId: string };
        }[];
      }) => {
        const match = pipeline[0].$match!;
        const record = records.find(
          (r) =>
            r.id === match._id.$oid &&
            r.notificationClaimId === match.notificationClaimId,
        );
        return Promise.resolve(
          record
            ? [
                {
                  ...record,
                  createdAt: record.createdAt.toISOString(),
                  conversation,
                },
              ]
            : [],
        );
      },
    ),
    count: jest.fn(() =>
      Promise.resolve(
        records.filter((r) => r.notificationNextAttemptAt).length,
      ),
    ),
  };
  const runCommand = jest.fn(
    ({
      updates,
    }: {
      updates: {
        q: {
          _id: { $oid: string };
          notificationClaimId?: string;
          notificationNextAttemptAt?: {
            $type: string;
            $lte: { $date: string };
          };
        };
        u: {
          $set: Record<string, unknown>;
          $inc?: { notificationAttemptCount: number };
        };
      }[];
    }) => {
      const { q, u } = updates[0];
      const record = records.find(
        (r) =>
          r.id === q._id.$oid &&
          (!q.notificationClaimId ||
            r.notificationClaimId === q.notificationClaimId) &&
          (!q.notificationNextAttemptAt ||
            (r.notificationNextAttemptAt instanceof Date &&
              r.notificationNextAttemptAt <=
                new Date(q.notificationNextAttemptAt.$lte.$date))),
      );
      if (!record) return Promise.resolve({ ok: 1, n: 0 });
      const values = Object.fromEntries(
        Object.entries(u.$set).map(([key, value]) => [
          key,
          value && typeof value === 'object' && '$date' in value
            ? new Date((value as { $date: string }).$date)
            : value,
        ]),
      );
      Object.assign(record, values);
      if (u.$inc)
        record.notificationAttemptCount += u.$inc.notificationAttemptCount;
      return Promise.resolve({ ok: 1, n: 1 });
    },
  );
  const notifications = {
    notifyNewMessage: jest.fn().mockResolvedValue(undefined),
  };
  const chats = {
    populateConversationParticipants: jest.fn((value: Conversation) => {
      value.participants = [{ id: 'sender', name: 'Sender' }];
      return Promise.resolve(value);
    }),
  };
  const encryption = {
    decrypt: jest.fn((content: string) => content.replace('encrypted:', '')),
  };
  const metrics = {
    measurePhase: jest.fn((_phase: string, action: () => unknown) => action()),
    recordNotificationOutbox: jest.fn(),
    setNotificationOutboxPending: jest.fn(),
  };
  const createWorker = () =>
    new MessageNotificationOutboxWorker(
      { message, $runCommandRaw: runCommand } as never,
      notifications as never,
      chats as never,
      encryption as never,
      metrics as never,
    );
  return {
    records,
    message,
    runCommand,
    notifications,
    chats,
    encryption,
    metrics,
    createWorker,
    setConversation: (next: typeof conversation) => {
      conversation = next;
    },
  };
};

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

describe('Message notification outbox', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('delivers the saved identity after decrypting and excludes removed/new members', async () => {
    const h = makeHarness();
    await h.createWorker().runOnce();
    expect(h.notifications.notifyNewMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        participantIds: ['sender', 'member'],
        participants: [{ id: 'sender', name: 'Sender' }],
      }),
      expect.objectContaining({ id: h.records[0].id, content: 'hello' }),
      'sender',
      expect.any(AbortSignal),
    );
    expect(h.records[0]).toMatchObject({
      notificationNextAttemptAt: null,
      notificationClaimId: null,
      notificationRecipientIds: [],
    });
    expect(h.metrics.recordNotificationOutbox).toHaveBeenCalledWith('queued');
    expect(h.metrics.setNotificationOutboxPending).toHaveBeenCalledWith(0);
  });

  it('reads current recall and membership after claiming, using one guarded lookup', async () => {
    const h = makeHarness();
    const claim = h.runCommand.getMockImplementation()!;
    h.runCommand.mockImplementationOnce(async (command) => {
      const result = await claim(command);
      h.setConversation({
        id: h.records[0].conversationId,
        participantIds: ['sender'],
        isGroup: true,
        name: null,
      });
      return result;
    });
    await h.createWorker().runOnce();
    expect(h.message.aggregateRaw).toHaveBeenCalledTimes(1);
    expect(h.message.aggregateRaw).toHaveBeenCalledWith(
      expect.objectContaining({
        pipeline: expect.arrayContaining([
          {
            $match: {
              _id: { $oid: h.records[0].id },
              notificationClaimId: expect.any(String),
            },
          },
          expect.objectContaining({
            $lookup: expect.objectContaining({
              from: 'conversations',
              localField: 'conversationId',
              foreignField: '_id',
            }),
          }),
        ]),
      }),
    );
    expect(h.notifications.notifyNewMessage).not.toHaveBeenCalled();
    expect(h.metrics.recordNotificationOutbox).toHaveBeenCalledWith(
      'cancelled',
    );
  });

  it('does not notify when a message is recalled between claim and read', async () => {
    const h = makeHarness();
    const claim = h.runCommand.getMockImplementation()!;
    h.runCommand.mockImplementationOnce(async (command) => {
      const result = await claim(command);
      h.records[0].isRecalled = true;
      return result;
    });
    await h.createWorker().runOnce();
    expect(h.notifications.notifyNewMessage).not.toHaveBeenCalled();
    expect(h.metrics.recordNotificationOutbox).toHaveBeenCalledWith(
      'cancelled',
    );
  });

  it('does not dispatch after a lease takeover before the saved record is read', async () => {
    const h = makeHarness();
    const claim = h.runCommand.getMockImplementation()!;
    h.runCommand.mockImplementationOnce(async (command) => {
      const result = await claim(command);
      h.records[0].notificationClaimId = 'other-worker';
      return result;
    });
    await h.createWorker().runOnce();
    expect(h.notifications.notifyNewMessage).not.toHaveBeenCalled();
    expect(h.records[0].notificationClaimId).toBe('other-worker');
    expect(h.records[0].notificationNextAttemptAt).not.toBeNull();
    expect(h.runCommand).toHaveBeenCalledTimes(1);
  });

  it.each([
    { senderId: 12 },
    { createdAt: 'not-a-date' },
    {
      conversation: {
        id: 'bad',
        participantIds: 'member',
        isGroup: true,
        name: null,
      },
    },
    { notificationRecipientIds: 'member' },
  ])('retains malformed raw records instead of sending %j', async (invalid) => {
    const h = makeHarness();
    h.message.aggregateRaw.mockImplementationOnce(
      () =>
        Promise.resolve([
          {
            ...h.records[0],
            createdAt: NOW.toISOString(),
            conversation: null,
            ...invalid,
          },
        ]) as never,
    );
    await h.createWorker().runOnce();
    expect(h.notifications.notifyNewMessage).not.toHaveBeenCalled();
    expect(h.records[0].notificationNextAttemptAt!.getTime()).toBeGreaterThan(
      NOW.getTime(),
    );
    expect(h.records[0].notificationRecipientIds).toEqual([
      'member',
      'removed',
    ]);
    expect(h.metrics.recordNotificationOutbox).toHaveBeenCalledWith('retry');
  });

  it('retains a failed intake and replays the same identity after backoff', async () => {
    const h = makeHarness();
    h.notifications.notifyNewMessage.mockRejectedValueOnce(
      new Error('HTTP 503'),
    );
    const worker = h.createWorker();
    await worker.runOnce();
    expect(h.records[0].notificationNextAttemptAt!.getTime()).toBeGreaterThan(
      NOW.getTime(),
    );
    expect(h.records[0].notificationRecipientIds).toEqual([
      'member',
      'removed',
    ]);
    expect(h.records[0].notificationAttemptCount).toBe(1);
    await worker.runOnce();
    expect(h.notifications.notifyNewMessage).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(4000);
    await worker.runOnce();
    expect(h.notifications.notifyNewMessage).toHaveBeenCalledTimes(2);
    expect(h.notifications.notifyNewMessage.mock.calls[0][1].id).toBe(
      h.notifications.notifyNewMessage.mock.calls[1][1].id,
    );
    expect(h.records[0].notificationNextAttemptAt).toBeNull();
  });

  it('reclaims an expired lease after a crashed process', async () => {
    const record = makeRecord();
    record.notificationClaimId = 'dead-process';
    record.notificationNextAttemptAt = new Date(NOW.getTime() + 30_000);
    const h = makeHarness([record]);
    await h.createWorker().runOnce();
    expect(h.notifications.notifyNewMessage).not.toHaveBeenCalled();
    jest.advanceTimersByTime(31_000);
    await h.createWorker().runOnce();
    expect(h.notifications.notifyNewMessage).toHaveBeenCalledTimes(1);
    expect(record.notificationNextAttemptAt).toBeNull();
  });

  it('does not deliver a candidate claimed by another instance', async () => {
    const h = makeHarness();
    await Promise.all([h.createWorker().runOnce(), h.createWorker().runOnce()]);
    expect(h.notifications.notifyNewMessage).toHaveBeenCalledTimes(1);
  });

  it.each(['success', 'failure'])(
    'fences a stale worker after lease takeover (%s)',
    async (outcome) => {
      const h = makeHarness();
      const old = deferred();
      const next = deferred();
      h.notifications.notifyNewMessage
        .mockImplementationOnce(() => old.promise)
        .mockImplementationOnce(() => next.promise);
      const first = h.createWorker().runOnce();
      await flush();
      const oldClaim = h.records[0].notificationClaimId;
      jest.advanceTimersByTime(31_000);
      const second = h.createWorker().runOnce();
      await flush();
      const nextClaim = h.records[0].notificationClaimId;
      expect(nextClaim).not.toBe(oldClaim);
      if (outcome === 'success') old.resolve();
      else old.reject(new Error('Timeout'));
      await first;
      expect(h.records[0].notificationClaimId).toBe(nextClaim);
      expect(h.records[0].notificationNextAttemptAt).not.toBeNull();
      expect(h.metrics.recordNotificationOutbox).toHaveBeenCalledWith(
        'lease_lost',
      );
      next.resolve();
      await second;
      expect(h.records[0].notificationNextAttemptAt).toBeNull();
    },
  );

  it.each(['recalled', 'deleted conversation', 'empty audience'])(
    'cancels an obsolete intent (%s)',
    async (reason) => {
      const h = makeHarness();
      if (reason === 'recalled') h.records[0].isRecalled = true;
      else if (reason === 'deleted conversation') h.setConversation(null);
      else h.records[0].notificationRecipientIds = ['removed'];
      await h.createWorker().runOnce();
      expect(h.notifications.notifyNewMessage).not.toHaveBeenCalled();
      expect(h.records[0].notificationNextAttemptAt).toBeNull();
      expect(h.metrics.recordNotificationOutbox).toHaveBeenCalledWith(
        'cancelled',
      );
    },
  );

  it('does not decrypt end-to-end encrypted messages', async () => {
    const h = makeHarness();
    h.records[0].signalType = 3;
    await h.createWorker().runOnce();
    expect(h.encryption.decrypt).not.toHaveBeenCalled();
  });

  it('retains work on a database failure while rescheduling', async () => {
    const h = makeHarness();
    h.message.aggregateRaw.mockRejectedValueOnce(new Error('DB unavailable'));
    const update = h.runCommand.getMockImplementation()!;
    h.runCommand
      .mockImplementationOnce(update)
      .mockRejectedValueOnce(new Error('Still unavailable'));
    await h.createWorker().runOnce();
    expect(h.records[0].notificationNextAttemptAt).not.toBeNull();
    expect(h.records[0].notificationClaimId).not.toBeNull();
    jest.advanceTimersByTime(31_000);
    await h.createWorker().runOnce();
    expect(h.records[0].notificationNextAttemptAt).toBeNull();
  });

  it('does not overlap polls and bounds intake to six concurrent requests', async () => {
    const h = makeHarness(
      Array.from({ length: 8 }, (_, index) => makeRecord(index + 1)),
    );
    const gates = Array.from({ length: 8 }, deferred);
    let started = 0;
    h.notifications.notifyNewMessage.mockImplementation(
      () => gates[started++].promise,
    );
    const worker = h.createWorker();
    const batch = worker.runOnce();
    expect(worker.runOnce()).toBe(batch);
    await flush();
    expect(started).toBe(6);
    gates[0].resolve();
    gates[1].resolve();
    await flush();
    expect(started).toBe(8);
    gates.slice(2).forEach((gate) => gate.resolve());
    await batch;
    expect(h.message.findRaw).toHaveBeenCalledTimes(1);
    expect(h.records.every((r) => r.notificationNextAttemptAt === null)).toBe(
      true,
    );
  });

  it('aborts intake on shutdown and lets restart recover its lease', async () => {
    const h = makeHarness();
    h.notifications.notifyNewMessage.mockImplementationOnce(
      (_conversation, _message, _sender, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('Stopped'))),
        ),
    );
    const worker = h.createWorker();
    const batch = worker.runOnce();
    await flush();
    await worker.onModuleDestroy();
    await batch;
    expect(h.records[0].notificationNextAttemptAt).not.toBeNull();
    await worker.runOnce();
    expect(h.notifications.notifyNewMessage).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(31_000);
    await h.createWorker().runOnce();
    expect(h.records[0].notificationNextAttemptAt).toBeNull();
  });

  it('drains a full batch without waiting for another timer tick', async () => {
    const h = makeHarness(
      Array.from({ length: 25 }, (_, index) => makeRecord(index + 1)),
    );
    await h.createWorker().runOnce();
    expect(h.message.findRaw).toHaveBeenCalledTimes(2);
    expect(h.notifications.notifyNewMessage).toHaveBeenCalledTimes(25);
    expect(h.records.every((r) => r.notificationNextAttemptAt === null)).toBe(
      true,
    );
    expect(h.message.count).toHaveBeenCalledTimes(1);
  });

  it('caps each drain at five batches and lets the next poll finish the backlog', async () => {
    const h = makeHarness(
      Array.from({ length: 125 }, (_, index) => makeRecord(index + 1)),
    );
    const worker = h.createWorker();
    await worker.runOnce();
    expect(h.message.findRaw).toHaveBeenCalledTimes(5);
    expect(h.notifications.notifyNewMessage).toHaveBeenCalledTimes(100);
    expect(
      h.records.filter((r) => r.notificationNextAttemptAt !== null),
    ).toHaveLength(25);
    await worker.runOnce();
    expect(h.notifications.notifyNewMessage).toHaveBeenCalledTimes(125);
    expect(h.records.every((r) => r.notificationNextAttemptAt === null)).toBe(
      true,
    );
  });

  it('waits for all six pipelines before fetching the next batch', async () => {
    const h = makeHarness(
      Array.from({ length: 21 }, (_, index) => makeRecord(index + 1)),
    );
    const gate = deferred();
    let active = 0;
    let peak = 0;
    h.notifications.notifyNewMessage.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await gate.promise;
      active--;
    });
    const worker = h.createWorker();
    const drain = worker.runOnce();
    expect(worker.runOnce()).toBe(drain);
    await flush();
    expect(h.message.findRaw).toHaveBeenCalledTimes(1);
    expect(active).toBe(6);
    gate.resolve();
    await drain;
    expect(peak).toBe(6);
    expect(h.message.findRaw).toHaveBeenCalledTimes(2);
  });

  it('does not fetch another batch after a delivery failure', async () => {
    const h = makeHarness(
      Array.from({ length: 21 }, (_, index) => makeRecord(index + 1)),
    );
    h.notifications.notifyNewMessage.mockRejectedValueOnce(
      new Error('Intake unavailable'),
    );
    await h.createWorker().runOnce();
    expect(h.message.findRaw).toHaveBeenCalledTimes(1);
    expect(h.notifications.notifyNewMessage).toHaveBeenCalledTimes(20);
    expect(h.records[0].notificationNextAttemptAt!.getTime()).toBeGreaterThan(
      NOW.getTime(),
    );
    expect(h.records[20].notificationAttemptCount).toBe(0);
  });

  it('does not spin on a full batch already claimed by another worker', async () => {
    const h = makeHarness(
      Array.from({ length: 20 }, (_, index) => makeRecord(index + 1)),
    );
    h.message.findRaw.mockResolvedValue(
      h.records.map((r) => ({ _id: { $oid: r.id } })),
    );
    h.records.forEach((r) => {
      r.notificationNextAttemptAt = new Date(NOW.getTime() + 60_000);
    });
    await h.createWorker().runOnce();
    expect(h.message.findRaw).toHaveBeenCalledTimes(1);
    expect(h.notifications.notifyNewMessage).not.toHaveBeenCalled();
  });

  it('does not fetch a new batch during shutdown', async () => {
    const h = makeHarness(
      Array.from({ length: 21 }, (_, index) => makeRecord(index + 1)),
    );
    h.notifications.notifyNewMessage.mockImplementation(
      (_conversation, _message, _sender, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('Stopped'))),
        ),
    );
    const worker = h.createWorker();
    const drain = worker.runOnce();
    await flush();
    await worker.onModuleDestroy();
    await drain;
    expect(h.message.findRaw).toHaveBeenCalledTimes(1);
    expect(h.notifications.notifyNewMessage).toHaveBeenCalledTimes(6);
    expect(h.records[20].notificationAttemptCount).toBe(0);
  });

  it('does not backfill historical messages without a due date', async () => {
    const historical = makeRecord();
    historical.notificationNextAttemptAt = null;
    const h = makeHarness([historical]);
    await h.createWorker().runOnce();
    expect(h.notifications.notifyNewMessage).not.toHaveBeenCalled();
    expect(h.runCommand).not.toHaveBeenCalled();
    expect(h.message.findRaw).toHaveBeenCalledWith(
      expect.objectContaining({
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
      }),
    );
  });

  it('fails the poll before claiming anything when a raw candidate ID is invalid', async () => {
    const h = makeHarness();
    h.message.findRaw.mockResolvedValueOnce([
      { _id: { $oid: h.records[0].id } },
      { _id: { $oid: 'invalid-object-id' } },
    ]);
    await h.createWorker().runOnce();
    expect(h.runCommand).not.toHaveBeenCalled();
    expect(h.notifications.notifyNewMessage).not.toHaveBeenCalled();
    expect(h.metrics.recordNotificationOutbox).toHaveBeenCalledWith(
      'poll_error',
    );
  });

  it('keeps due/claim guards on the actual write and never upserts', async () => {
    const h = makeHarness();
    await h.createWorker().runOnce();
    expect(h.runCommand).toHaveBeenCalledTimes(2);
    const claim = h.runCommand.mock.calls[0][0];
    const complete = h.runCommand.mock.calls[1][0];
    expect(claim).toMatchObject({
      update: 'messages',
      writeConcern: { w: 'majority' },
      updates: [
        {
          q: {
            _id: { $oid: h.records[0].id },
            notificationNextAttemptAt: {
              $type: 'date',
              $lte: { $date: NOW.toISOString() },
            },
          },
          multi: false,
          upsert: false,
        },
      ],
    });
    expect(complete).toMatchObject({
      updates: [
        {
          q: {
            notificationClaimId: claim.updates[0].u.$set.notificationClaimId,
          },
        },
      ],
    });
  });

  it.each([
    { ok: 0, n: 1 },
    { ok: 1 },
    { ok: 1, n: 2 },
    { ok: 1, n: 1, writeErrors: [{ code: 121 }] },
    { ok: 1, n: 1, writeConcernError: { code: 64 } },
  ])('does not send after an ambiguous claim receipt %j', async (receipt) => {
    const h = makeHarness();
    h.runCommand.mockResolvedValueOnce(receipt as never);
    await h.createWorker().runOnce();
    expect(h.notifications.notifyNewMessage).not.toHaveBeenCalled();
    expect(h.records[0].notificationRecipientIds).toEqual([
      'member',
      'removed',
    ]);
    expect(h.records[0].notificationNextAttemptAt).not.toBeNull();
  });

  it('retains the intent when Mongo reports a per-write completion error', async () => {
    const h = makeHarness();
    const update = h.runCommand.getMockImplementation()!;
    h.runCommand.mockImplementationOnce(update).mockResolvedValueOnce({
      ok: 1,
      n: 0,
      writeErrors: [{ code: 121 }],
    } as never);
    await h.createWorker().runOnce();
    expect(h.notifications.notifyNewMessage).toHaveBeenCalledTimes(1);
    expect(h.records[0].notificationNextAttemptAt!.getTime()).toBeGreaterThan(
      NOW.getTime(),
    );
    expect(h.records[0].notificationRecipientIds).toEqual([
      'member',
      'removed',
    ]);
    expect(h.metrics.recordNotificationOutbox).toHaveBeenCalledWith('retry');
    expect(h.metrics.recordNotificationOutbox).not.toHaveBeenCalledWith(
      'queued',
    );
  });

  it.each(['null', 'future'])(
    'ignores a stale candidate whose due date is %s',
    async (state) => {
      const h = makeHarness();
      h.records[0].notificationNextAttemptAt =
        state === 'null' ? null : new Date(NOW.getTime() + 60_000);
      h.message.findRaw.mockResolvedValueOnce([
        { _id: { $oid: h.records[0].id } },
      ]);
      await h.createWorker().runOnce();
      expect(h.notifications.notifyNewMessage).not.toHaveBeenCalled();
      expect(h.records[0].notificationClaimId).toBeNull();
      expect(h.records[0].notificationAttemptCount).toBe(0);
    },
  );
});
