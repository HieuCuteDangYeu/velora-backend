import { PrismaService } from '@friend/infrastructure/prisma/prisma.service';
import { FriendGraphRepository } from './friend-graph.repository';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';
const E = '55555555-5555-4555-8555-555555555555';
const X = '66666666-6666-4666-8666-666666666666';
const Y = '77777777-7777-4777-8777-777777777777';

const HUB_USERS = [
  '88888888-8888-4888-8888-888888888881',
  '88888888-8888-4888-8888-888888888882',
  '88888888-8888-4888-8888-888888888883',
  '88888888-8888-4888-8888-888888888884',
  '88888888-8888-4888-8888-888888888885',
];

const describeWithDatabase =
  process.env.FRIEND_GRAPH_INTEGRATION_TEST === '1' ? describe : describe.skip;

describeWithDatabase('FriendGraphRepository integration', () => {
  const prisma = new PrismaService();
  const repository = new FriendGraphRepository(prisma);

  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    await prisma.userBlock.deleteMany();
    await prisma.friendship.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const createRelationship = async (
    firstUserId: string,
    secondUserId: string,
    status: 'PENDING' | 'ACCEPTED' = 'ACCEPTED',
  ) => {
    const [userOneId, userTwoId] = [firstUserId, secondUserId].sort();

    await prisma.friendship.create({
      data: {
        requesterId: firstUserId,
        recipientId: secondUserId,
        userOneId,
        userTwoId,
        status,
        respondedAt: status === 'ACCEPTED' ? new Date() : null,
      },
    });
  };

  it('Graph A: returns a single two-hop candidate with one mutual friend', async () => {
    await createRelationship(A, B);
    await createRelationship(B, C);

    const candidates = await repository.findTwoHopCandidates(A);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      userId: C,
      mutualFriendCount: 1,
    });
    expect(candidates[0].adamicAdarScore).toBeCloseTo(1 / Math.log(2), 8);
  });

  it('Graph B: counts both independent mutual-friend paths', async () => {
    await createRelationship(A, B);
    await createRelationship(A, C);
    await createRelationship(B, D);
    await createRelationship(C, D);

    const candidates = await repository.findTwoHopCandidates(A);
    const candidate = candidates.find((item) => item.userId === D);

    expect(candidate).toBeDefined();
    expect(candidate?.mutualFriendCount).toBe(2);
    expect(candidate?.adamicAdarScore).toBeCloseTo(2 / Math.log(2), 8);
  });

  it('Graph C: gives stronger evidence to the candidate with more mutuals', async () => {
    await createRelationship(A, B);
    await createRelationship(A, C);
    await createRelationship(B, D);
    await createRelationship(C, D);
    await createRelationship(B, E);

    const candidates = await repository.findTwoHopCandidates(A);
    const candidateD = candidates.find((item) => item.userId === D);
    const candidateE = candidates.find((item) => item.userId === E);

    expect(candidateD?.mutualFriendCount).toBe(2);
    expect(candidateE?.mutualFriendCount).toBe(1);
    expect(candidateD?.adamicAdarScore).toBeGreaterThan(
      candidateE?.adamicAdarScore ?? 0,
    );
  });

  it('Graph D: penalizes paths through a high-degree hub', async () => {
    await createRelationship(A, B);
    await createRelationship(A, C);
    await createRelationship(B, X);
    await createRelationship(C, Y);

    for (const hubUserId of HUB_USERS) {
      await createRelationship(B, hubUserId);
    }

    const candidates = await repository.findTwoHopCandidates(A);
    const throughHub = candidates.find((item) => item.userId === X);
    const throughSmallNeighborhood = candidates.find(
      (item) => item.userId === Y,
    );

    expect(throughHub?.mutualFriendCount).toBe(1);
    expect(throughSmallNeighborhood?.mutualFriendCount).toBe(1);
    expect(throughSmallNeighborhood?.adamicAdarScore).toBeGreaterThan(
      throughHub?.adamicAdarScore ?? Number.POSITIVE_INFINITY,
    );
  });

  it('Graph E: excludes candidates that are already directly connected', async () => {
    await createRelationship(A, B);
    await createRelationship(B, C);
    await createRelationship(C, A);

    const candidates = await repository.findTwoHopCandidates(A);

    expect(candidates).toEqual([]);
  });

  it('Graph F: excludes an existing pending relationship in either direction', async () => {
    await createRelationship(A, B);
    await createRelationship(B, C);
    await createRelationship(C, A, 'PENDING');

    const candidates = await repository.findTwoHopCandidates(A);

    expect(candidates).toEqual([]);
  });
});
