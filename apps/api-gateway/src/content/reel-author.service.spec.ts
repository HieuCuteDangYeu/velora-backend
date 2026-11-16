import type { ClientProxy } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { ReelAuthorService } from './reel-author.service';

const profile = (id: string) => ({
  id,
  username: `user-${id}`,
  fullName: `User ${id}`,
  picture: null,
  isVerified: false,
});

describe('ReelAuthorService', () => {
  it('looks authors up once and serves repeat page loads from memory', async () => {
    const send = jest.fn().mockReturnValue(of([profile('a'), profile('b')]));
    const service = new ReelAuthorService({ send } as unknown as ClientProxy);

    const first = await service.loadAuthorMap(['a', 'b', 'a']);
    const second = await service.loadAuthorMap(['b', 'a']);

    expect(send).toHaveBeenCalledTimes(1);
    expect(first.get('a')?.username).toBe('user-a');
    expect(second.get('b')?.displayName).toBe('User b');
  });

  it('asks only for authors it does not have yet', async () => {
    const send = jest
      .fn()
      .mockReturnValueOnce(of([profile('a')]))
      .mockReturnValueOnce(of([profile('c')]));
    const service = new ReelAuthorService({ send } as unknown as ClientProxy);

    await service.loadAuthorMap(['a']);
    await service.loadAuthorMap(['a', 'c']);

    expect(send).toHaveBeenLastCalledWith('user.find_public_by_ids', ['c']);
  });

  it('falls back to bare authors without caching when the lookup fails', async () => {
    const send = jest
      .fn()
      .mockReturnValueOnce(throwError(() => new Error('user-service down')))
      .mockReturnValue(of([profile('a')]));
    const service = new ReelAuthorService({ send } as unknown as ClientProxy);

    const degraded = await service.loadAuthorMap(['a']);
    expect(degraded.get('a')?.username).toBeNull();

    const recovered = await service.loadAuthorMap(['a']);
    expect(recovered.get('a')?.username).toBe('user-a');
    expect(send).toHaveBeenCalledTimes(2);
  });
});
