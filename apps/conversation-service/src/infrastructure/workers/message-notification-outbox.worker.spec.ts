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
    findMany: jest.fn(
      ({
        where,
        take,
      }: {
        where: { notificationNextAttemptAt: { lte: Date } };
        take: number;
      }) => {
        const due = records.filter(
          (r) =>
            r.notificationNextAttemptAt &&
            r.notificationNextAttemptAt <= where.notificationNextAttemptAt.lte,
        );
        return Promise.resolve(due.slice(0, take).map(({ id }) => ({ id })));
      },
    ),
    findUnique: jest.fn(({ where }: { where: { id: string } }) => {
      const record = records.find((r) => r.id === where.id);
      return Promise.resolve(record ? { ...record, conversation } : null);
    }),
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
    h.message.findUnique.mockRejectedValueOnce(new Error('DB unavailable'));
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

  it('does not overlap polls and bounds intake to two concurrent requests', async () => {
    const h = makeHarness(
      Array.from({ length: 6 }, (_, index) => makeRecord(index + 1)),
    );
    const gates = Array.from({ length: 6 }, deferred);
    let started = 0;
    h.notifications.notifyNewMessage.mockImplementation(
      () => gates[started++].promise,
    );
    const worker = h.createWorker();
    const batch = worker.runOnce();
    expect(worker.runOnce()).toBe(batch);
    await flush();
    expect(started).toBe(2);
    gates[0].resolve();
    gates[1].resolve();
    await flush();
    expect(started).toBe(4);
    gates[2].resolve();
    gates[3].resolve();
    await flush();
    expect(started).toBe(6);
    gates[4].resolve();
    gates[5].resolve();
    await batch;
    expect(h.message.findMany).toHaveBeenCalledTimes(1);
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

  it('does not backfill historical messages without a due date', async () => {
    const historical = makeRecord();
    historical.notificationNextAttemptAt = null;
    const h = makeHarness([historical]);
    await h.createWorker().runOnce();
    expect(h.notifications.notifyNewMessage).not.toHaveBeenCalled();
    expect(h.runCommand).not.toHaveBeenCalled();
    expect(h.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          notificationNextAttemptAt: { not: null, lte: expect.any(Date) },
        },
      }),
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
      h.message.findMany.mockResolvedValueOnce([{ id: h.records[0].id }]);
      await h.createWorker().runOnce();
      expect(h.notifications.notifyNewMessage).not.toHaveBeenCalled();
      expect(h.records[0].notificationClaimId).toBeNull();
      expect(h.records[0].notificationAttemptCount).toBe(0);
    },
  );
});
