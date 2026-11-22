import { lastValueFrom, of } from 'rxjs';
import { RoleController } from './role.controller';

describe('RoleController ban RPCs', () => {
  const controller = (ban = jest.fn(), unban = jest.fn()) =>
    new RoleController(
      undefined as never,
      undefined as never,
      { execute: ban } as never,
      { execute: unban } as never,
    );

  it('replies with a value so the caller does not see an empty stream', async () => {
    const ban = jest.fn().mockResolvedValue(undefined);
    const unban = jest.fn().mockResolvedValue(undefined);
    const c = controller(ban, unban);
    // The user-service adapter consumes these replies with lastValueFrom, which throws
    // EmptyError on a reply that carries no value.
    await expect(
      lastValueFrom(of(await c.banUser({ userId: 'u1' }))),
    ).resolves.toEqual({ ok: true });
    await expect(
      lastValueFrom(of(await c.unbanUser({ userId: 'u1' }))),
    ).resolves.toEqual({ ok: true });
    expect(ban).toHaveBeenCalledWith('u1');
    expect(unban).toHaveBeenCalledWith('u1');
  });

  it('does not acknowledge a ban that failed', async () => {
    const c = controller(jest.fn().mockRejectedValue(new Error('redis down')));
    await expect(c.banUser({ userId: 'u1' })).rejects.toThrow('redis down');
  });
});
