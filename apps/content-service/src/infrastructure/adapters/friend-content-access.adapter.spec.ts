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

  describe('canView', () => {
    const viewing = {
      viewerId: 'v1',
      ownerId: 'o1',
      visibility: 'public',
    } as const;
    const build = (allowed: boolean | Error) => {
      const send = jest
        .fn()
        .mockImplementation(() =>
          allowed instanceof Error
            ? throwError(() => allowed)
            : of({ allowed }),
        );
      return {
        send,
        adapter: new FriendContentAccessAdapter({
          send,
        } as unknown as ClientProxy),
      };
    };

    it('lets an owner open their own reels without asking friend-service', async () => {
      const { adapter, send } = build(false);

      await expect(
        adapter.canView({ ...viewing, viewerId: 'o1', visibility: 'private' }),
      ).resolves.toBe(true);
      expect(send).not.toHaveBeenCalled();
    });

    it('denies someone else a private reel without asking friend-service', async () => {
      const { adapter, send } = build(true);

      await expect(
        adapter.canView({ ...viewing, visibility: 'private' }),
      ).resolves.toBe(false);
      expect(send).not.toHaveBeenCalled();
    });

    it('remembers a yes for the same viewer, owner and visibility', async () => {
      const { adapter, send } = build(true);

      await adapter.canView(viewing);
      await adapter.canView(viewing);
      await adapter.canView({ ...viewing, visibility: 'friends' });
      await adapter.canView({ ...viewing, viewerId: 'v2' });

      expect(send).toHaveBeenCalledTimes(3);
    });

    it('never remembers a denial, so a newly allowed viewer gets in at once', async () => {
      const { adapter, send } = build(false);

      await expect(adapter.canView(viewing)).resolves.toBe(false);
      await expect(adapter.canView(viewing)).resolves.toBe(false);
      expect(send).toHaveBeenCalledTimes(2);
    });

    it('treats a failed lookup as a denial and asks again next time', async () => {
      const { adapter, send } = build(new Error('friend-service down'));

      await expect(adapter.canView(viewing)).resolves.toBe(false);
      await expect(adapter.canView(viewing)).resolves.toBe(false);
      expect(send).toHaveBeenCalledTimes(2);
    });
  });
});
