import {
  ForbiddenException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
} from '@nestjs/common';
import type {
  Conversation as PrismaConversation,
  Message as PrismaMessage,
} from '@prisma/conversation-client';
import { mongo } from 'mongoose';
import type { ConversationPrometheusMetricsService } from '../metrics/conversation-prometheus-metrics.service';
import {
  buildMessageRecords,
  type PreparedMessageWrite,
} from './message-write-records';

/** The same message was already stored for this sender and client key. */
export class DuplicateClientMessageError extends Error {
  constructor() {
    super('Duplicate client message id');
    this.name = 'DuplicateClientMessageError';
  }
}

/** MongoDB aborted the transaction on a write conflict; the whole batch can be retried. */
export class MessageWriteConflictError extends Error {
  constructor() {
    super('Message transaction write conflict');
    this.name = 'MessageWriteConflictError';
  }
}

export type NativeMessageWriterOptions = {
  maxPoolSize: number;
  // How long a transaction may wait for a free connection / server.
  waitQueueTimeoutMs: number;
  // Upper bound for any single database round trip inside the transaction.
  operationTimeoutMs: number;
};

export const DEFAULT_NATIVE_WRITER_OPTIONS: NativeMessageWriterOptions = {
  maxPoolSize: 20,
  waitQueueTimeoutMs: 2_000,
  operationTimeoutMs: 5_000,
};

type ConversationDocument = {
  _id: mongo.ObjectId;
  creator_id: string;
  participantIds: string[];
  isGroup: boolean;
  name?: string | null;
  picture?: string | null;
  memberJoinedAt?: PrismaConversation['memberJoinedAt'];
  createdAt: Date;
  updatedAt: Date;
  lastMessage?: string | null;
  lastMessageAt?: Date | null;
};

export type PersistedMessage = readonly [PrismaMessage, PrismaConversation];

const OBJECT_ID = /^[a-f0-9]{24}$/i;

/**
 * Writes a batch of messages and the conversation preview in ONE MongoDB
 * transaction using the official driver directly. It stores exactly what the
 * Prisma path stores (same collections, field set and BSON types) but skips the
 * Prisma query engine: a Prisma interactive transaction is four engine round
 * trips (begin, preview command, createMany, commit), and measured at 230
 * msg/s that engine and its finalizers were about a quarter of the
 * conversation-service main thread.
 */
export class NativeMessageWriter implements OnModuleDestroy {
  private readonly logger = new Logger(NativeMessageWriter.name);
  private readonly client: mongo.MongoClient;
  private readonly options: NativeMessageWriterOptions;
  private connected?: Promise<unknown>;

  constructor(
    url: string,
    private readonly metrics?: Pick<
      ConversationPrometheusMetricsService,
      'recordMongoCommand'
    >,
    options: Partial<NativeMessageWriterOptions> = {},
    client?: mongo.MongoClient,
  ) {
    this.options = { ...DEFAULT_NATIVE_WRITER_OPTIONS, ...options };
    this.client =
      client ??
      new mongo.MongoClient(url, {
        appName: 'conversation-service-writer',
        maxPoolSize: this.options.maxPoolSize,
        waitQueueTimeoutMS: this.options.waitQueueTimeoutMs,
        serverSelectionTimeoutMS: this.options.waitQueueTimeoutMs,
        socketTimeoutMS: this.options.operationTimeoutMs,
        retryWrites: true,
      });
  }

  /** Opens the pool up front so the first message does not pay for it. */
  connect(): Promise<unknown> {
    this.connected ??= this.client.connect().catch((error: unknown) => {
      this.connected = undefined;
      throw error;
    });
    return this.connected;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.close().catch((error: unknown) => {
      this.logger.warn(`Closing the message writer failed: ${String(error)}`);
    });
  }

  async write(
    writes: readonly PreparedMessageWrite[],
  ): Promise<PersistedMessage[]> {
    const last = writes[writes.length - 1];
    if (!last) return [];
    const conversationId = last.data.conversationId;
    if (!OBJECT_ID.test(conversationId)) {
      throw new NotFoundException('Conversation not found');
    }
    const senders = [...new Set(writes.map((write) => write.data.senderId))];
    if (senders.length === 0 || senders.some((sender) => !sender)) {
      throw new InternalServerErrorException('Missing authorized sender');
    }

    await this.connect();
    const database = this.client.db();
    const conversations =
      database.collection<ConversationDocument>('conversations');
    const messages = database.collection('messages');
    const conversationObjectId = new mongo.ObjectId(conversationId);
    const timeout = this.options.operationTimeoutMs;

    const session = this.client.startSession();
    let active = false;
    try {
      session.startTransaction({
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        readPreference: 'primary',
        maxCommitTimeMS: timeout,
      });
      active = true;
      const timestamp = new Date();

      // Membership check and preview update in one command, inside the
      // transaction: a failed or duplicate message insert rolls it back, and a
      // matching document takes the same write-conflict protection as a read
      // followed by an update would.
      const startedPreview = process.hrtime.bigint();
      const snapshot = await conversations.findOneAndUpdate(
        {
          _id: conversationObjectId,
          participantIds: senders.length === 1 ? senders[0] : { $all: senders },
        },
        {
          $set: {
            lastMessage: last.preview,
            lastMessageAt: timestamp,
            updatedAt: timestamp,
          },
        },
        {
          returnDocument: 'after',
          session,
          maxTimeMS: timeout,
        },
      );
      this.record('conversation_update', startedPreview);

      if (!snapshot) {
        // Failure only: keep the 404/403 distinction without a read on the
        // successful path. Nothing has been inserted yet.
        const existing = await conversations.findOne(
          { _id: conversationObjectId },
          { session, projection: { participantIds: 1 } },
        );
        if (!existing) throw new NotFoundException('Conversation not found');
        if (senders.some((id) => !existing.participantIds?.includes(id))) {
          throw new ForbiddenException(
            'You are not allowed to access messages in this conversation',
          );
        }
        throw new InternalServerErrorException(
          'Conversation preview did not match its authorized sender',
        );
      }
      if (
        snapshot.lastMessage !== last.preview ||
        snapshot.updatedAt.getTime() !== timestamp.getTime() ||
        senders.some((id) => !snapshot.participantIds.includes(id))
      ) {
        throw new InternalServerErrorException(
          'Conversation preview returned an inconsistent snapshot',
        );
      }

      const conversation = toConversation(snapshot);
      const records = buildMessageRecords(writes, conversation, timestamp);

      const startedInsert = process.hrtime.bigint();
      const inserted = await messages.insertMany(
        records.map(toMessageDocument),
        { session, ordered: true },
      );
      this.record('message_insert', startedInsert);
      if (inserted.insertedCount !== records.length) {
        throw new InternalServerErrorException(
          'Message insert did not create all records',
        );
      }

      await session.commitTransaction();
      active = false;
      return records.map((record) => [record, conversation] as const);
    } catch (error: unknown) {
      if (active) {
        // Never mask the original error with a failed abort.
        await session.abortTransaction().catch(() => undefined);
      }
      throw this.translate(error);
    } finally {
      await session.endSession().catch(() => undefined);
    }
  }

  private record(
    command: 'conversation_update' | 'message_insert',
    started: bigint,
  ) {
    this.metrics?.recordMongoCommand(
      command,
      Number(process.hrtime.bigint() - started) / 1e9,
    );
  }

  // Map driver errors onto the two outcomes the repository already handles.
  // Anything else (including an unknown commit result, which must never be
  // replayed) propagates unchanged.
  private translate(error: unknown): unknown {
    if (error instanceof mongo.MongoError) {
      if (error.hasErrorLabel('TransientTransactionError')) {
        return new MessageWriteConflictError();
      }
      if (isDuplicateKey(error)) return new DuplicateClientMessageError();
    }
    return error;
  }
}

function isDuplicateKey(error: mongo.MongoError): boolean {
  if (error.code === 11000) return true;
  const writeErrors = (error as { writeErrors?: unknown }).writeErrors;
  const list = Array.isArray(writeErrors) ? writeErrors : [writeErrors];
  return list.some(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as { code?: unknown }).code === 11000,
  );
}

function toConversation(document: ConversationDocument): PrismaConversation {
  return {
    id: document._id.toHexString(),
    creatorId: document.creator_id,
    participantIds: document.participantIds,
    isGroup: document.isGroup,
    name: document.name ?? null,
    picture: document.picture ?? null,
    memberJoinedAt: document.memberJoinedAt ?? null,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    lastMessage: document.lastMessage ?? null,
    lastMessageAt: document.lastMessageAt ?? null,
  };
}

// The stored shape of a message, field for field what Prisma createMany writes.
function toMessageDocument(record: PrismaMessage) {
  return {
    _id: new mongo.ObjectId(record.id),
    type: record.type,
    clientMessageId: record.clientMessageId,
    content: record.content,
    media: record.media ?? null,
    metadata: record.metadata ?? null,
    senderId: record.senderId,
    isRecalled: record.isRecalled,
    recalledAt: record.recalledAt ?? null,
    replyToId: record.replyToId ? new mongo.ObjectId(record.replyToId) : null,
    replyPreview: record.replyPreview ?? null,
    conversationId: new mongo.ObjectId(record.conversationId),
    reactions: record.reactions ?? null,
    readBy: [],
    notificationClaimId: record.notificationClaimId ?? null,
    notificationAttemptCount: record.notificationAttemptCount,
    createdAt: record.createdAt,
    notificationRecipientIds: record.notificationRecipientIds,
    notificationNextAttemptAt: record.notificationNextAttemptAt ?? null,
  };
}
