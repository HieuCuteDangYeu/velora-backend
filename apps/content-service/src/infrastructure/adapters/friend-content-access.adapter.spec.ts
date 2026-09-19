import type { ClientProxy } from '@nestjs/microservices';
import { throwError } from 'rxjs';
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
});
