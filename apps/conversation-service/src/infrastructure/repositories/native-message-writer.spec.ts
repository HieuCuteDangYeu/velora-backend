import {
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { mongo } from 'mongoose';
import {
  DuplicateClientMessageError,
  MessageWriteConflictError,
  NativeMessageWriter,
} from './native-message-writer';
import type { PreparedMessageWrite } from './message-write-records';

const CONVERSATION_ID = '6af774b69b6c568d77df5413';
const MESSAGE_ID = '6afd4932debb2ed2c205d92b';

type Doc = Record<string, unknown>;

const makeWrite = (over: Partial<PreparedMessageWrite['data']> = {}) =>
  ({
    preview: 'hello',
    enqueueNotification: true,
    data: {
      id: MESSAGE_ID,
      type: 'text',
      clientMessageId: 'client-1',
      content: 'cipher',
      media: null,
      metadata: null,
      senderId: 'alice',
      isRecalled: false,
      recalledAt: null,
      replyToId: null,
      replyPreview: null,
      conversationId: CONVERSATION_ID,
      reactions: null,
      readBy: [],
      notificationClaimId: null,
      notificationAttemptCount: 0,
      ...over,
    },
  }) as unknown as PreparedMessageWrite;

// A scripted MongoDB: records the calls and lets each test decide what fails.
function makeHarness(
  conversation: Partial<Doc> | null = {},
  insert: () => Promise<{ insertedCount: number }> | undefined = () =>
    undefined,
) {
  const calls: string[] = [];
  const stored: { update?: Doc; filter?: Doc; docs?: Doc[] } = {};
  const session = {
    startTransaction: jest.fn(() => calls.push('start')),
    commitTransaction: jest.fn(() => {
      calls.push('commit');
      return Promise.resolve();
    }),
    abortTransaction: jest.fn(() => {
      calls.push('abort');
      return Promise.resolve();
    }),
    endSession: jest.fn(() => Promise.resolve()),
  };
  const conversations = {
    findOneAndUpdate: jest.fn((filter: Doc, update: { $set: Doc }) => {
      calls.push('preview');
      stored.filter = filter;
      stored.update = update.$set;
      return Promise.resolve(
        conversation === null
          ? null
          : {
              _id: new mongo.ObjectId(CONVERSATION_ID),
              creator_id: 'alice',
              participantIds: ['alice', 'bob'],
              isGroup: false,
              createdAt: new Date(0),
              ...conversation,
              lastMessage: update.$set['lastMessage'],
              lastMessageAt: update.$set['lastMessageAt'],
              updatedAt: update.$set['updatedAt'],
            },
      );
    }),
    findOne: jest.fn(() => {
      calls.push('lookup');
      return Promise.resolve(
        (globalThis as { existing?: Doc }).existing ?? null,
      );
    }),
  };
  const messages = {
    insertMany: jest.fn((docs: Doc[]) => {
      calls.push('insert');
      stored.docs = docs;
      return insert() ?? Promise.resolve({ insertedCount: docs.length });
    }),
  };
  const client = {
    connect: jest.fn(() => Promise.resolve()),
    close: jest.fn(() => Promise.resolve()),
    startSession: jest.fn(() => session),
    db: () => ({
      collection: (name: string) =>
        name === 'conversations' ? conversations : messages,
    }),
  };
  const metrics = { recordMongoCommand: jest.fn() };
  const writer = new NativeMessageWriter(
    'mongodb://localhost/test',
    metrics,
    {},
    client as unknown as mongo.MongoClient,
  );
  return { writer, calls, stored, session, conversations, messages, metrics };
}

describe('NativeMessageWriter', () => {
  afterEach(() => {
    delete (globalThis as { existing?: Doc }).existing;
  });

  it('updates the preview, inserts the message and commits in one transaction', async () => {
    const { writer, calls, stored, session, metrics } = makeHarness();

    const [[message, conversation]] = await writer.write([makeWrite()]);

    expect(calls).toEqual(['start', 'preview', 'insert', 'commit']);
    expect(session.endSession).toHaveBeenCalled();
    expect(stored.filter).toEqual({
      _id: new mongo.ObjectId(CONVERSATION_ID),
      participantIds: 'alice',
    });
    expect(message.createdAt).toBe(stored.update?.['lastMessageAt']);
    expect(conversation).toMatchObject({
      id: CONVERSATION_ID,
      participantIds: ['alice', 'bob'],
      lastMessage: 'hello',
      name: null,
      picture: null,
    });
    expect(metrics.recordMongoCommand).toHaveBeenCalledWith(
      'conversation_update',
      expect.any(Number),
    );
    expect(metrics.recordMongoCommand).toHaveBeenCalledWith(
      'message_insert',
      expect.any(Number),
    );
  });

  it('stores exactly the field set and BSON types Prisma stores', async () => {
    const { writer, stored } = makeHarness();

    await writer.write([makeWrite({ replyToId: '6afd4932debb2ed2c205d92c' })]);

    const [doc] = stored.docs as Doc[];
    expect(Object.keys(doc).sort()).toEqual(
      [
        '_id',
        'type',
        'clientMessageId',
        'content',
        'media',
        'metadata',
        'senderId',
        'isRecalled',
        'recalledAt',
        'replyToId',
        'replyPreview',
        'conversationId',
        'reactions',
        'readBy',
        'notificationClaimId',
        'notificationAttemptCount',
        'createdAt',
        'notificationRecipientIds',
        'notificationNextAttemptAt',
      ].sort(),
    );
    expect(doc['_id']).toEqual(new mongo.ObjectId(MESSAGE_ID));
    expect(doc['conversationId']).toEqual(new mongo.ObjectId(CONVERSATION_ID));
    expect(doc['replyToId']).toEqual(
      new mongo.ObjectId('6afd4932debb2ed2c205d92c'),
    );
    expect(doc['createdAt']).toBeInstanceOf(Date);
    expect(doc['readBy']).toEqual([]);
    // A one-to-one chat notifies its single other member, due immediately.
    expect(doc['notificationRecipientIds']).toEqual(['bob']);
    expect(doc['notificationNextAttemptAt']).toBe(doc['createdAt']);
  });

  it('batches several messages and requires every sender to be a member', async () => {
    const { writer, calls, stored } = makeHarness();

    const result = await writer.write([
      makeWrite({ id: '6afd4932debb2ed2c205d92b' }),
      makeWrite({
        id: '6afd4932debb2ed2c205d92c',
        senderId: 'bob',
        clientMessageId: 'client-2',
      }),
    ]);

    expect(result).toHaveLength(2);
    expect(calls.filter((call) => call === 'insert')).toHaveLength(1);
    expect(stored.filter?.['participantIds']).toEqual({
      $all: ['alice', 'bob'],
    });
    expect(stored.docs).toHaveLength(2);
  });

  it('does not queue notifications when the caller did not ask for them', async () => {
    const { writer, stored } = makeHarness();

    await writer.write([{ ...makeWrite(), enqueueNotification: false }]);

    const [doc] = stored.docs as Doc[];
    expect(doc['notificationRecipientIds']).toEqual([]);
    expect(doc['notificationNextAttemptAt']).toBeNull();
  });

  it('reports a missing conversation as 404 and rolls back', async () => {
    const { writer, calls } = makeHarness(null);

    await expect(writer.write([makeWrite()])).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(calls).toEqual(['start', 'preview', 'lookup', 'abort']);
  });

  it('reports a non-member as 403 and inserts nothing', async () => {
    const { writer, calls } = makeHarness(null);
    (globalThis as { existing?: Doc }).existing = {
      participantIds: ['carol'],
    };

    await expect(writer.write([makeWrite()])).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(calls).not.toContain('insert');
    expect(calls).toContain('abort');
  });

  it('rejects a malformed conversation id without touching the database', async () => {
    const { writer, session } = makeHarness();

    await expect(
      writer.write([makeWrite({ conversationId: 'not-an-object-id' })]),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(session.startTransaction).not.toHaveBeenCalled();
  });

  it('turns a duplicate client message key into DuplicateClientMessageError', async () => {
    const duplicate = new mongo.MongoServerError({
      message: 'E11000 duplicate key',
      code: 11000,
    });
    const { writer, calls } = makeHarness({}, () => Promise.reject(duplicate));

    await expect(writer.write([makeWrite()])).rejects.toBeInstanceOf(
      DuplicateClientMessageError,
    );
    expect(calls).toEqual(['start', 'preview', 'insert', 'abort']);
  });

  it('recognises a duplicate reported inside a bulk write error', async () => {
    const bulk = new mongo.MongoServerError({ message: 'bulk', code: 65 });
    (bulk as unknown as { writeErrors: unknown[] }).writeErrors = [
      { code: 11000 },
    ];
    const { writer } = makeHarness({}, () => Promise.reject(bulk));

    await expect(writer.write([makeWrite()])).rejects.toBeInstanceOf(
      DuplicateClientMessageError,
    );
  });

  it('turns a transient transaction error (write conflict) into a retryable error', async () => {
    const conflict = new mongo.MongoServerError({
      message: 'WriteConflict',
      code: 112,
    });
    conflict.addErrorLabel('TransientTransactionError');
    const { writer, calls } = makeHarness({}, () => Promise.reject(conflict));

    await expect(writer.write([makeWrite()])).rejects.toBeInstanceOf(
      MessageWriteConflictError,
    );
    expect(calls).toContain('abort');
  });

  it('never retries or masks an unknown commit result', async () => {
    const unknown = new mongo.MongoServerError({
      message: 'commit outcome unknown',
      code: 91,
    });
    unknown.addErrorLabel('UnknownTransactionCommitResult');
    const harness = makeHarness();
    harness.session.commitTransaction.mockRejectedValueOnce(unknown);

    await expect(harness.writer.write([makeWrite()])).rejects.toBe(unknown);
    expect(harness.messages.insertMany).toHaveBeenCalledTimes(1);
  });

  it('fails when the insert does not create every record', async () => {
    const { writer } = makeHarness({}, () =>
      Promise.resolve({ insertedCount: 0 }),
    );

    await expect(writer.write([makeWrite()])).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('opens the connection once and closes it on shutdown', async () => {
    const harness = makeHarness();
    const client = (
      harness.writer as unknown as { client: { connect: jest.Mock } }
    ).client;

    await harness.writer.write([makeWrite()]);
    await harness.writer.write([makeWrite()]);
    await harness.writer.onModuleDestroy();

    expect(client.connect).toHaveBeenCalledTimes(1);
  });
});
