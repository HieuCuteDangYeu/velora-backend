import type { ClientProxy } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { FriendDiscoveryServiceAdapter } from './friend-discovery-service.adapter';

const VIEWER_ID = '11111111-1111-4111-8111-111111111111';
const CANDIDATE_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';

const validResponse = () => ({
  candidates: [
    {
      userId: CANDIDATE_ID,
      mutualFriendCount: 2,
      adamicAdarScore: 0.75,
      graphScore: 0.9,
      candidateSources: ['MUTUAL_FRIENDS', 'ADAMIC_ADAR'],
    },
  ],
  excludedUserIds: [VIEWER_ID],
});

const createAdapter = (response: unknown) => {
  const client = {
    send: jest.fn().mockReturnValue(of(response)),
  } as Pick<ClientProxy, 'send'>;

  return {
    adapter: new FriendDiscoveryServiceAdapter(client as ClientProxy),
    send: client.send,
  };
};

describe('FriendDiscoveryServiceAdapter graph recommendation contract', () => {
  it('accepts a complete valid graph response', async () => {
    const { adapter } = createAdapter(validResponse());

    await expect(
      adapter.getGraphRecommendations(VIEWER_ID, 20),
    ).resolves.toEqual(validResponse());
  });

  it('fails closed when the exclusion list omits the viewer', async () => {
    const { adapter } = createAdapter({
      ...validResponse(),
      excludedUserIds: [],
    });

    await expect(
      adapter.getGraphRecommendations(VIEWER_ID, 20),
    ).rejects.toThrow('Incomplete graph friend recommendation exclusions');
  });

  it('fails closed when graph candidate IDs are duplicated', async () => {
    const candidate = validResponse().candidates[0];
    const { adapter } = createAdapter({
      ...validResponse(),
      candidates: [candidate, candidate],
    });

    await expect(
      adapter.getGraphRecommendations(VIEWER_ID, 20),
    ).rejects.toThrow('Invalid graph friend recommendation candidates');
  });

  it('fails closed when a candidate conflicts with an exclusion', async () => {
    const { adapter } = createAdapter({
      ...validResponse(),
      excludedUserIds: [VIEWER_ID, CANDIDATE_ID],
    });

    await expect(
      adapter.getGraphRecommendations(VIEWER_ID, 20),
    ).rejects.toThrow('Conflicting graph friend recommendation candidates');
  });

  it('fails closed on malformed IDs and response fields', async () => {
    const { adapter } = createAdapter({
      candidates: [
        {
          userId: 'not-a-uuid',
          mutualFriendCount: 1,
          adamicAdarScore: 0.5,
          graphScore: 0.5,
          candidateSources: ['MUTUAL_FRIENDS'],
        },
      ],
      excludedUserIds: [OTHER_ID],
    });

    await expect(
      adapter.getGraphRecommendations(VIEWER_ID, 20),
    ).rejects.toThrow('Invalid graph friend recommendation response');
  });

  it('converts RMQ failures into a fail-closed recommendation error', async () => {
    const client = {
      send: jest
        .fn()
        .mockReturnValue(throwError(() => new Error('friend-service down'))),
    } as Pick<ClientProxy, 'send'>;
    const adapter = new FriendDiscoveryServiceAdapter(client as ClientProxy);

    await expect(
      adapter.getGraphRecommendations(VIEWER_ID, 20),
    ).rejects.toThrow('Failed to load graph friend recommendations');
  });
});
