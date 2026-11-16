import type { ClientProxy } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { FriendContentAccessAdapter } from './friend-content-access.adapter';

describe('FriendContentAccessAdapter', () => {
  it('propagates feed-audience RPC failures instead of returning empty exclusions', async () => {
    const send = jest
      .fn()
      .mockReturnValue(throwError(() => new Error('friend-service down')));
    const adapter = new FriendContentAccessAdapter({
      send,
    } as unknown as ClientProxy);

    await expect(adapter.getFeedAudience('viewer-1')).rejects.toThrow(
      'friend-service down',
    );
  });

  it('reuses one audience lookup per viewer and hands each caller its own arrays', async () => {
    const send = jest
      .fn()
      .mockReturnValue(of({ friendUserIds: ['f1'], excludedUserIds: ['b1'] }));
    const adapter = new FriendContentAccessAdapter({
      send,
    } as unknown as ClientProxy);

    const first = await adapter.getFeedAudience('viewer-1');
    first.excludedUserIds.push('tampered');
    const second = await adapter.getFeedAudience('viewer-1');
    await adapter.getFeedAudience('viewer-2');

    expect(second.excludedUserIds).toEqual(['b1']);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed lookup', async () => {
    const send = jest
      .fn()
      .mockReturnValueOnce(throwError(() => new Error('friend-service down')))
      .mockReturnValue(of({ friendUserIds: [], excludedUserIds: [] }));
    const adapter = new FriendContentAccessAdapter({
      send,
    } as unknown as ClientProxy);

    await expect(adapter.getFeedAudience('viewer-1')).rejects.toThrow(
      'friend-service down',
    );
    await expect(adapter.getFeedAudience('viewer-1')).resolves.toEqual({
      friendUserIds: [],
      excludedUserIds: [],
    });
  });
});
