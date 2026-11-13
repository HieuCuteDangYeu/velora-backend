import { PrismaChatRepository } from './prisma-chat.repository';

const USER = '11111111-1111-4111-8111-111111111111';
const FRIEND = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

const rows = [
  { participantIds: [USER, FRIEND] },
  { participantIds: [USER, FRIEND, OTHER] },
];

const makeRepository = (readReplica?: { read: jest.Mock }) => {
  const prisma = {
    conversation: { findMany: jest.fn().mockResolvedValue(rows) },
  };
  const repository = new PrismaChatRepository(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    readReplica as never,
  );
  return { repository, prisma };
};

describe('PrismaChatRepository presence audience', () => {
  it('reads from the primary when no replica service is configured', async () => {
    const { repository, prisma } = makeRepository();
    expect(await repository.findPresenceAudienceUserIds(USER)).toEqual([
      FRIEND,
      OTHER,
    ]);
    expect(prisma.conversation.findMany).toHaveBeenCalledWith({
      where: { participantIds: { has: USER } },
      select: { participantIds: true },
    });
  });

  it('routes the read through the replica service as presence_audience', async () => {
    const replicaClient = {
      conversation: { findMany: jest.fn().mockResolvedValue(rows) },
    };
    const read = jest.fn(
      (
        _operation: string,
        query: (client: typeof replicaClient) => Promise<unknown>,
      ) => query(replicaClient),
    );
    const { repository, prisma } = makeRepository({ read });

    // The audience excludes the user and lists each member once.
    expect(await repository.findPresenceAudienceUserIds(USER)).toEqual([
      FRIEND,
      OTHER,
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0][0]).toBe('presence_audience');
    // No confirmMiss: an empty audience is a valid answer, not a miss.
    expect(read.mock.calls[0]).toHaveLength(2);
    expect(replicaClient.conversation.findMany).toHaveBeenCalledWith({
      where: { participantIds: { has: USER } },
      select: { participantIds: true },
    });
    expect(prisma.conversation.findMany).not.toHaveBeenCalled();
  });

  it('returns an empty audience for a user with no conversations', async () => {
    const read = jest.fn().mockResolvedValue([]);
    const { repository } = makeRepository({ read });
    expect(await repository.findPresenceAudienceUserIds(USER)).toEqual([]);
  });

  it('propagates a failure of the replica service (it already falls back to the primary itself)', async () => {
    const failure = new Error('both members failed');
    const read = jest.fn().mockRejectedValue(failure);
    const { repository } = makeRepository({ read });
    await expect(repository.findPresenceAudienceUserIds(USER)).rejects.toBe(
      failure,
    );
  });
});
