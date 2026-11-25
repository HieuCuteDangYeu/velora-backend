import { Conversation } from '../../domain/entities/conversation.entity';
import {
  MessageNotificationOutboxWorker,
  OUTBOX_BATCH_SIZE,
  OUTBOX_BUSY_CONCURRENCY,
  OUTBOX_BUSY_MESSAGES_PER_SECOND,
  OUTBOX_CHUNK_SIZE,
  OUTBOX_CONCURRENCY,
  OUTBOX_DEFAULT_BUSY_RATE,
  OUTBOX_DEFAULT_BUSY_THRESHOLD,
} from './message-notification-outbox.worker';
import { NotificationBatchRejectedError } from '../adapters/notification-service.adapter';

const NOW = new Date('2026-10-07T00:00:00.000Z');
const makeRecord = (index = 1) => ({
  id: index.toString(16).padStart(24, '0'),
  conversationId: '507f1f77bcf86cd799439011',
  senderId: 'sender',
  clientMessageId: `client-${index}`,
  content: 'encrypted:hello',
  type: 'text',
  media: null,
  metadata: null,
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
  const backlogReads = jest.fn<void, [unknown]>();
  const readMatches = jest.fn<void, [unknown]>();
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
          $count?: string;
        }[];
      }) => {
        // The backlog gauge: a date-typed range plus $count, answered like Mongo
        // (no document at all when nothing is pending).
        if (pipeline.some((stage) => stage.$count !== undefined)) {
          backlogReads(pipeline);
          const pending = records.filter(
            (r) => r.notificationNextAttemptAt instanceof Date,
          ).length;
          return Promise.resolve(pending > 0 ? [{ pending }] : []);
        }
        const match = pipeline[0].$match! as unknown as {
          _id: { $in: { $oid: string }[] };
          notificationClaimId: { $in: string[] };
        };
        readMatches(match);
        const ids = match._id.$in.map(({ $oid }) => $oid);
        return Promise.resolve(
          records
            .filter(
              (r) =>
                ids.includes(r.id) &&
                r.notificationClaimId !== null &&
                match.notificationClaimId.$in.includes(r.notificationClaimId),
            )
            .map((record) => ({
              ...record,
              createdAt: record.createdAt.toISOString(),
              conversation,
            })),
        );
      },
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
      let n = 0;
      for (const { q, u } of updates) {
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
        if (!record) continue;
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
        n++;
      }
      return Promise.resolve({ ok: 1, n });
    },
  );
  const notifications = {
    notifyNewMessage: jest.fn().mockResolvedValue(undefined),
    // Like the adapter's 404 fallback: the batch is the single intake per item,
    // so each test can keep asserting per-message calls.
    notifyNewMessages: jest.fn(
      async (
        items: {
          conversation: Conversation;
          message: unknown;
          actorUserId: string;
        }[],
        signal?: AbortSignal,
      ) => {
        for (const item of items) {
          await notifications.notifyNewMessage(
            item.conversation,
            item.message,
            item.actorUserId,
            signal,
          );
        }
      },
    ),
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
    messagesCreatedPerSecond: jest.fn(() => 0),
    recordNotificationOutbox: jest.fn(),
    setNotificationOutboxPending: jest.fn(),
  };
  const createWorker = (redis?: unknown) =>
    new MessageNotificationOutboxWorker(
      { message, $runCommandRaw: runCommand } as never,
      notifications as never,
      chats as never,
      encryption as never,
      metrics as never,
      redis as never,
    );
  return {
    records,
    message,
    backlogReads,
    readMatches,
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

  it('does not poll the outbox when it is switched off for this replica', () => {
    const h = makeHarness();
    process.env.CONVERSATION_NOTIFICATION_OUTBOX = 'off';
    try {
      h.createWorker().onModuleInit();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      delete process.env.CONVERSATION_NOTIFICATION_OUTBOX;
    }
    const worker = h.createWorker();
    worker.onModuleInit();
    expect(jest.getTimerCount()).toBe(1);
    void worker.onModuleDestroy();
  });

  describe('leader mode', () => {
    const startLeaderWorker = async (
      redis: { eval: jest.Mock },
      records = [makeRecord()],
    ) => {
      const h = makeHarness(records);
      process.env.CONVERSATION_NOTIFICATION_OUTBOX = 'leader';
      const worker = h.createWorker(redis);
      worker.onModuleInit();
      delete process.env.CONVERSATION_NOTIFICATION_OUTBOX;
      await flush();
      return { h, worker };
    };

    it('drains while this replica holds the lease', async () => {
      const redis = { eval: jest.fn().mockResolvedValue(1) };
      const { h, worker } = await startLeaderWorker(redis);
      await worker.runOnce();
      expect(redis.eval).toHaveBeenCalled();
      expect(h.notifications.notifyNewMessage).toHaveBeenCalledTimes(1);
      await worker.onModuleDestroy();
    });

    it('leaves the outbox alone but keeps its backlog gauge current while another replica leads', async () => {
      const redis = { eval: jest.fn().mockResolvedValue(0) };
      const { h, worker } = await startLeaderWorker(redis);
      await worker.runOnce();
      expect(h.message.findRaw).not.toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({ limit: OUTBOX_BATCH_SIZE }),
        }),
      );
      expect(h.notifications.notifyNewMessage).not.toHaveBeenCalled();
      expect(h.metrics.setNotificationOutboxPending).toHaveBeenCalled();
      await worker.onModuleDestroy();
    });

    it('keeps delivering when Redis cannot answer', async () => {
      const redis = { eval: jest.fn().mockRejectedValue(new Error('down')) };
      const { h, worker } = await startLeaderWorker(redis);
      await worker.runOnce();
      expect(h.notifications.notifyNewMessage).toHaveBeenCalledTimes(1);
      await worker.onModuleDestroy();
    });

    it('renews the lease on its own timer, not once per batch', async () => {
      const redis = { eval: jest.fn().mockResolvedValue(1) };
      const { worker } = await startLeaderWorker(redis);
      const first = redis.eval.mock.calls.length;
      jest.advanceTimersByTime(6_000);
      await flush();
      expect(redis.eval.mock.calls.length).toBeGreaterThanOrEqual(first + 3);
      await worker.onModuleDestroy();
    });

    it('stops a long drain once the lease is lost', async () => {
      const records = Array.from({ length: OUTBOX_BATCH_SIZE * 3 }, (_, i) =>
        makeRecord(i + 1),
      );
      const redis = {
        eval: jest.fn().mockResolvedValueOnce(1).mockResolvedValue(0),
      };
      const { h, worker } = await startLeaderWorker(redis, records);
      h.notifications.notifyNewMessage.mockImplementationOnce(async () => {
        jest.advanceTimersByTime(2_000);
        await flush();
      });
      await worker.runOnce();
      expect(h.notifications.notifyNewMessage.mock.calls.length).toBeLessThan(
        records.length,
      );
      expect(h.notifications.notifyNewMessage).toHaveBeenCalled();
      await worker.onModuleDestroy();
    });

    it('hands the lease over on shutdown', async () => {
      const redis = { eval: jest.fn().mockResolvedValue(1) };
      const { worker } = await startLeaderWorker(redis);
      await worker.onModuleDestroy();
      const lastScript = redis.eval.mock.calls.at(-1)![0] as string;
      expect(lastScript).toContain("redis.call('del'");
    });

    it('does not use the lease unless leader mode is switched on', async () => {
      const redis = { eval: jest.fn().mockResolvedValue(0) };
      const h = makeHarness();
      await h.createWorker(redis).runOnce();
      expect(redis.eval).not.toHaveBeenCalled();
      expect(h.notifications.notifyNewMessage).toHaveBeenCalledTimes(1);
    });
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
    // One intent lookup; the backlog gauge's $count pipeline is a separate call.
    expect(
      h.message.aggregateRaw.mock.calls.filter(
        ([arg]) => !arg.pipeline.some((stage) => stage.$count !== undefined),
      ),
    ).toHaveLength(1);
    expect(h.message.aggregateRaw).toHaveBeenCalledWith(
      expect.objectContaining({
        pipeline: expect.arrayContaining([
          {
            $match: {
              _id: { $in: [{ $oid: h.records[0].id }] },
              notificationClaimId: { $in: [expect.any(String)] },
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

  it('does not overlap polls and bounds intake to the configured chunks in flight', async () => {
    const chunks = OUTBOX_BATCH_SIZE / OUTBOX_CHUNK_SIZE;
    const h = makeHarness(
      Array.from({ length: OUTBOX_BATCH_SIZE }, (_, index) =>
        makeRecord(index + 1),
      ),
    );
    const gates = Array.from({ length: chunks * 2 }, deferred);
    let started = 0;
    h.notifications.notifyNewMessages.mockImplementation(
      () => gates[started++].promise,
    );
    const worker = h.createWorker();
    const batch = worker.runOnce();
    expect(worker.runOnce()).toBe(batch);
    await flush();
    expect(started).toBe(Math.min(chunks, OUTBOX_CONCURRENCY));
    // One request per chunk, never one per intent.
    expect(
      h.notifications.notifyNewMessages.mock.calls.map(
        (call) => call[0].length,
      ),
    ).toEqual(Array(started).fill(OUTBOX_CHUNK_SIZE));
    for (const gate of gates) gate.resolve();
    await batch;
    expect(h.records.every((r) => r.notificationNextAttemptAt === null)).toBe(
      true,
    );
  });

  it('keeps a single chunk in flight while chat traffic is heavy', async () => {
    const h = makeHarness(
      Array.from({ length: OUTBOX_CHUNK_SIZE * 2 }, (_, index) =>
        makeRecord(index + 1),
      ),
    );
    h.metrics.messagesCreatedPerSecond.mockReturnValue(
      OUTBOX_BUSY_MESSAGES_PER_SECOND,
    );
    const gates = [deferred(), deferred()];
    let started = 0;
    h.notifications.notifyNewMessages.mockImplementation(
      () => gates[started++].promise,
    );
    const batch = h.createWorker().runOnce();
    await flush();
    expect(started).toBe(OUTBOX_BUSY_CONCURRENCY);
    gates[0].resolve();
    await flush();
    expect(started).toBe(2);
    gates[1].resolve();
    await batch;
    expect(h.records.every((r) => r.notificationNextAttemptAt === null)).toBe(
      true,
    );
  });

  it('claims, reads and completes a whole chunk with one command each', async () => {
    const h = makeHarness(
      Array.from({ length: OUTBOX_CHUNK_SIZE }, (_, index) =>
        makeRecord(index + 1),
      ),
    );
    await h.createWorker().runOnce();
    // claim + complete; each statement keeps its own guard and claim id.
    expect(h.runCommand).toHaveBeenCalledTimes(2);
    const [claim, complete] = h.runCommand.mock.calls.map(
      (call) => call[0].updates,
    );
    expect(claim).toHaveLength(OUTBOX_CHUNK_SIZE);
    expect(complete).toHaveLength(OUTBOX_CHUNK_SIZE);
    const claimIds = claim.map(
      (statement) => statement.u.$set.notificationClaimId as string,
    );
    expect(new Set(claimIds).size).toBe(OUTBOX_CHUNK_SIZE);
    expect(
      complete.map((statement) => statement.q.notificationClaimId),
    ).toEqual(claimIds);
    expect(h.readMatches).toHaveBeenCalledTimes(1);
    expect(h.notifications.notifyNewMessages).toHaveBeenCalledTimes(1);
    expect(h.records.every((r) => r.notificationNextAttemptAt === null)).toBe(
      true,
    );
  });

  it('keeps the whole chunk for a later replay when the intake is unavailable', async () => {
    const h = makeHarness([makeRecord(1), makeRecord(2), makeRecord(3)]);
    h.notifications.notifyNewMessages.mockRejectedValueOnce(
      new Error('HTTP 503'),
    );
    await h.createWorker().runOnce();
    // No one-by-one hammering of a service that is down.
    expect(h.notifications.notifyNewMessage).not.toHaveBeenCalled();
    for (const record of h.records) {
      expect(record.notificationClaimId).toBeNull();
      expect(record.notificationNextAttemptAt!.getTime()).toBeGreaterThan(
        NOW.getTime(),
      );
      expect(record.notificationRecipientIds).toEqual(['member', 'removed']);
    }
  });

  it('isolates an intent the intake rejects as invalid and delivers the rest', async () => {
    const h = makeHarness([makeRecord(1), makeRecord(2), makeRecord(3)]);
    h.notifications.notifyNewMessages.mockRejectedValueOnce(
      new NotificationBatchRejectedError(),
    );
    h.notifications.notifyNewMessage
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('HTTP 400'))
      .mockResolvedValueOnce(undefined);
    await h.createWorker().runOnce();
    expect(h.notifications.notifyNewMessage).toHaveBeenCalledTimes(3);
    expect(h.records[0].notificationNextAttemptAt).toBeNull();
    expect(h.records[1].notificationNextAttemptAt).not.toBeNull();
    expect(h.records[1].notificationRecipientIds).toEqual([
      'member',
      'removed',
    ]);
    expect(h.records[2].notificationNextAttemptAt).toBeNull();
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

  it.each([
    [
      'yields to live traffic at the busy threshold',
      OUTBOX_BUSY_MESSAGES_PER_SECOND,
      OUTBOX_BUSY_CONCURRENCY,
    ],
    [
      'yields during a much heavier burst',
      OUTBOX_BUSY_MESSAGES_PER_SECOND * 20,
      OUTBOX_BUSY_CONCURRENCY,
    ],
    [
      'runs at full speed just below the threshold',
      OUTBOX_BUSY_MESSAGES_PER_SECOND - 1,
      OUTBOX_CONCURRENCY,
    ],
    ['runs at full speed when traffic is idle', 0, OUTBOX_CONCURRENCY],
  ])('the drain %s', async (_name, rate, expectedLanes) => {
    const h = makeHarness(
      Array.from({ length: OUTBOX_BATCH_SIZE }, (_, index) =>
        makeRecord(index + 1),
      ),
    );
    h.metrics.messagesCreatedPerSecond.mockReturnValue(rate);
    const gate = deferred();
    let active = 0;
    let peak = 0;
    h.notifications.notifyNewMessage.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await gate.promise;
      active--;
    });
    const drain = h.createWorker().runOnce();
    await flush();
    expect(active).toBe(expectedLanes);
    gate.resolve();
    await drain;
    expect(peak).toBe(expectedLanes);
    expect(h.notifications.notifyNewMessage).toHaveBeenCalledTimes(
      OUTBOX_BATCH_SIZE,
    );
  });

  it('drains a full batch without waiting for another timer tick', async () => {
    const total = OUTBOX_BATCH_SIZE + 5;
    const h = makeHarness(
      Array.from({ length: total }, (_, index) => makeRecord(index + 1)),
    );
    await h.createWorker().runOnce();
    expect(h.message.findRaw).toHaveBeenCalledTimes(2);
    expect(h.notifications.notifyNewMessage).toHaveBeenCalledTimes(total);
    expect(h.records.every((r) => r.notificationNextAttemptAt === null)).toBe(
      true,
    );
    expect(h.backlogReads).toHaveBeenCalledTimes(1);
  });

  it('samples the backlog with a date-typed range on the due-date index, never a null comparison', async () => {
    const h = makeHarness([makeRecord(1), makeRecord(2)]);
    await h.createWorker().runOnce();
    const [pipeline] = h.backlogReads.mock.calls[0] as [
      { $match?: { notificationNextAttemptAt: Record<string, unknown> } }[],
    ];
    // Prisma's `not: null` becomes $expr and scans every message; this shape is
    // the one the due-date read already proves can use the index.
    expect(pipeline[0].$match?.notificationNextAttemptAt).toEqual({
      $type: 'date',
      $lte: { $date: expect.any(String) as string },
    });
    expect(h.message).not.toHaveProperty('count');
    expect(h.metrics.setNotificationOutboxPending).toHaveBeenCalledWith(0);
  });

  it('a failing backlog gauge read never interrupts delivery or counts as a poll error', async () => {
    const h = makeHarness([makeRecord(1)]);
    const original = h.message.aggregateRaw.getMockImplementation()!;
    h.message.aggregateRaw.mockImplementation((arg) =>
      arg.pipeline.some((stage) => stage.$count !== undefined)
        ? Promise.reject(new Error('count failed'))
        : original(arg),
    );
    await h.createWorker().runOnce();
    expect(h.notifications.notifyNewMessage).toHaveBeenCalledTimes(1);
    expect(h.records[0].notificationNextAttemptAt).toBeNull();
    expect(h.metrics.recordNotificationOutbox).not.toHaveBeenCalledWith(
      'poll_error',
    );
    expect(h.metrics.setNotificationOutboxPending).not.toHaveBeenCalled();
  });

  it('keeps draining a long backlog in one run while every batch is full', async () => {
    const total = OUTBOX_BATCH_SIZE * 6 + 5;
    const h = makeHarness(
      Array.from({ length: total }, (_, index) => makeRecord(index + 1)),
    );
    await h.createWorker().runOnce();
    // Six full batches and a partial one: no five-batch cap, no second poll needed.
    expect(h.message.findRaw).toHaveBeenCalledTimes(7);
    expect(h.notifications.notifyNewMessage).toHaveBeenCalledTimes(total);
    expect(h.records.every((r) => r.notificationNextAttemptAt === null)).toBe(
      true,
    );
  });

  it('waits for all pipelines before fetching the next batch', async () => {
    const h = makeHarness(
      Array.from({ length: OUTBOX_BATCH_SIZE + 1 }, (_, index) =>
        makeRecord(index + 1),
      ),
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
    expect(active).toBe(OUTBOX_CONCURRENCY);
    gate.resolve();
    await drain;
    expect(peak).toBe(OUTBOX_CONCURRENCY);
    expect(h.message.findRaw).toHaveBeenCalledTimes(2);
  });

  it('does not fetch another batch after a delivery failure', async () => {
    const h = makeHarness(
      Array.from({ length: OUTBOX_BATCH_SIZE + 1 }, (_, index) =>
        makeRecord(index + 1),
      ),
    );
    h.notifications.notifyNewMessage.mockRejectedValueOnce(
      new Error('Intake unavailable'),
    );
    await h.createWorker().runOnce();
    expect(h.message.findRaw).toHaveBeenCalledTimes(1);
    // Every chunk of the batch is still attempted once.
    expect(h.notifications.notifyNewMessages).toHaveBeenCalledTimes(
      OUTBOX_BATCH_SIZE / OUTBOX_CHUNK_SIZE,
    );
    expect(h.records[0].notificationNextAttemptAt!.getTime()).toBeGreaterThan(
      NOW.getTime(),
    );
    expect(h.records[OUTBOX_BATCH_SIZE].notificationAttemptCount).toBe(0);
  });

  it('does not spin on a full batch already claimed by another worker', async () => {
    const h = makeHarness(
      Array.from({ length: OUTBOX_BATCH_SIZE }, (_, index) =>
        makeRecord(index + 1),
      ),
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
      Array.from({ length: OUTBOX_BATCH_SIZE + 1 }, (_, index) =>
        makeRecord(index + 1),
      ),
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
    expect(h.notifications.notifyNewMessage).toHaveBeenCalledTimes(
      OUTBOX_CONCURRENCY,
    );
    expect(h.records[OUTBOX_BATCH_SIZE].notificationAttemptCount).toBe(0);
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
          limit: OUTBOX_BATCH_SIZE,
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

  describe('chat first (CONVERSATION_OUTBOX_PRIORITY=chat)', () => {
    const fleetRedis = (reports: Record<string, string>) => {
      const exec = jest.fn().mockResolvedValue([]);
      type Chain = { hset: jest.Mock; pexpire: jest.Mock; exec: jest.Mock };
      const chain: Chain = { hset: jest.fn(), pexpire: jest.fn(), exec };
      chain.hset.mockReturnValue(chain);
      chain.pexpire.mockReturnValue(chain);
      return {
        eval: jest.fn().mockResolvedValue(1),
        multi: jest.fn(() => chain),
        hgetall: jest.fn(() => Promise.resolve(reports)),
        hdel: jest.fn().mockResolvedValue(1),
        chain,
      };
    };
    const withChatFirst = <T>(make: () => T): T => {
      process.env.CONVERSATION_OUTBOX_PRIORITY = 'chat';
      try {
        return make();
      } finally {
        delete process.env.CONVERSATION_OUTBOX_PRIORITY;
      }
    };
    const backlog = (n: number) =>
      Array.from({ length: n }, (_, index) => makeRecord(index + 1));
    const fresh = (rate: number) => `${rate}:${NOW.getTime()}`;

    it('only trickles notifications while the fleet is busy, even if this replica is quiet', async () => {
      const h = makeHarness(backlog(OUTBOX_BATCH_SIZE));
      // Four replicas at 30 messages/s each: busy as a fleet, quiet locally.
      const redis = fleetRedis({
        a: fresh(30),
        b: fresh(30),
        c: fresh(30),
        d: fresh(30),
      });
      const worker = withChatFirst(() => h.createWorker(redis));
      await worker.runOnce();
      expect(h.message.findRaw).toHaveBeenCalledTimes(1);
      expect(h.message.findRaw.mock.calls[0][0].options.limit).toBe(
        OUTBOX_DEFAULT_BUSY_RATE,
      );
      expect(
        h.records.filter((r) => r.notificationNextAttemptAt === null),
      ).toHaveLength(OUTBOX_DEFAULT_BUSY_RATE);
    });

    it('drains at full speed once the fleet is below the threshold', async () => {
      const h = makeHarness(backlog(OUTBOX_BATCH_SIZE + 10));
      const redis = fleetRedis({ a: fresh(10), b: fresh(20) });
      const worker = withChatFirst(() => h.createWorker(redis));
      await worker.runOnce();
      expect(h.records.every((r) => r.notificationNextAttemptAt === null)).toBe(
        true,
      );
    });

    it('ignores stale reports from replicas that went away, and prunes them', async () => {
      const h = makeHarness(backlog(OUTBOX_BATCH_SIZE));
      const old = NOW.getTime() - 60_000;
      const redis = fleetRedis({ gone: `500:${old}`, a: fresh(10) });
      const worker = withChatFirst(() => h.createWorker(redis));
      await worker.runOnce();
      expect(h.records.every((r) => r.notificationNextAttemptAt === null)).toBe(
        true,
      );
      expect(redis.hdel).toHaveBeenCalledWith('chat:outbox:rates', 'gone');
    });

    it('stops a long drain as soon as traffic picks up again', async () => {
      const h = makeHarness(backlog(OUTBOX_BATCH_SIZE * 3));
      const reports: Record<string, string> = { a: fresh(0) };
      const redis = fleetRedis(reports);
      const worker = withChatFirst(() => h.createWorker(redis));
      h.notifications.notifyNewMessages.mockImplementation(() => {
        reports.a = fresh(OUTBOX_DEFAULT_BUSY_THRESHOLD);
        return Promise.resolve();
      });
      await worker.runOnce();
      const delivered = h.records.filter(
        (r) => r.notificationNextAttemptAt === null,
      ).length;
      expect(delivered).toBe(OUTBOX_BATCH_SIZE + OUTBOX_DEFAULT_BUSY_RATE);
    });

    it('falls back to its own traffic when Redis cannot answer', async () => {
      const h = makeHarness(backlog(OUTBOX_BATCH_SIZE));
      const redis = fleetRedis({});
      redis.hgetall.mockRejectedValue(new Error('down'));
      h.metrics.messagesCreatedPerSecond.mockReturnValue(
        OUTBOX_DEFAULT_BUSY_THRESHOLD,
      );
      const worker = withChatFirst(() => h.createWorker(redis));
      await worker.runOnce();
      expect(h.message.findRaw.mock.calls[0][0].options.limit).toBe(
        OUTBOX_DEFAULT_BUSY_RATE,
      );
    });

    it('reports its traffic every second even when its own outbox is off', async () => {
      const h = makeHarness();
      h.metrics.messagesCreatedPerSecond.mockReturnValue(42);
      const redis = fleetRedis({});
      process.env.CONVERSATION_NOTIFICATION_OUTBOX = 'off';
      const worker = withChatFirst(() => h.createWorker(redis));
      try {
        withChatFirst(() => worker.onModuleInit());
      } finally {
        delete process.env.CONVERSATION_NOTIFICATION_OUTBOX;
      }
      jest.advanceTimersByTime(1_000);
      await flush();
      expect(redis.chain.hset).toHaveBeenCalledWith(
        'chat:outbox:rates',
        expect.any(String),
        `42:${NOW.getTime() + 1_000}`,
      );
      expect(h.message.findRaw).not.toHaveBeenCalled();
      await worker.onModuleDestroy();
    });

    it('keeps the previous behaviour when the priority is not set', async () => {
      const h = makeHarness(backlog(OUTBOX_BATCH_SIZE));
      const redis = fleetRedis({ a: fresh(1_000) });
      await h.createWorker(redis).runOnce();
      expect(redis.hgetall).not.toHaveBeenCalled();
      expect(h.records.every((r) => r.notificationNextAttemptAt === null)).toBe(
        true,
      );
    });
  });
});
