import type { ClientProxy } from '@nestjs/microservices';
import { Subject, of, throwError } from 'rxjs';
import {
  REEL_AUTHOR_CACHE_TTL_MS,
  REEL_AUTHOR_STALE_LIMIT_MS,
  ReelAuthorService,
} from './reel-author.service';

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
  describe('after the minute is up', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('answers at once with the known profile and refreshes it in the background', async () => {
      jest.useFakeTimers();
      const refresh = new Subject<ReturnType<typeof profile>[]>();
      const send = jest
        .fn()
        .mockReturnValueOnce(of([profile('a')]))
        .mockReturnValueOnce(refresh);
      const service = new ReelAuthorService({ send } as unknown as ClientProxy);

      await service.loadAuthorMap(['a']);
      jest.setSystemTime(Date.now() + REEL_AUTHOR_CACHE_TTL_MS + 1_000);

      const stale = await service.loadAuthorMap(['a']);
      expect(stale.get('a')?.displayName).toBe('User a');
      expect(send).toHaveBeenCalledTimes(2);

      refresh.next([{ ...profile('a'), fullName: 'Renamed' }]);
      refresh.complete();
      await jest.advanceTimersByTimeAsync(0);
      const fresh = await service.loadAuthorMap(['a']);
      expect(fresh.get('a')?.displayName).toBe('Renamed');
      expect(send).toHaveBeenCalledTimes(2);
    });

    it('waits for a new lookup once the stale limit has passed', async () => {
      jest.useFakeTimers();
      const send = jest
        .fn()
        .mockReturnValueOnce(of([profile('a')]))
        .mockReturnValueOnce(of([{ ...profile('a'), fullName: 'Later' }]));
      const service = new ReelAuthorService({ send } as unknown as ClientProxy);

      await service.loadAuthorMap(['a']);
      jest.setSystemTime(Date.now() + REEL_AUTHOR_STALE_LIMIT_MS + 1_000);

      const result = await service.loadAuthorMap(['a']);
      expect(result.get('a')?.displayName).toBe('Later');
    });
  });

  it('sends one lookup for requests that need the same author at the same time', async () => {
    const answer = new Subject<ReturnType<typeof profile>[]>();
    const send = jest.fn().mockReturnValue(answer);
    const service = new ReelAuthorService({ send } as unknown as ClientProxy);

    const first = service.loadAuthorMap(['a', 'b']);
    const second = service.loadAuthorMap(['b', 'a']);
    const third = service.loadAuthorMap(['a']);
    answer.next([profile('a'), profile('b')]);
    answer.complete();
    const [one, two, three] = await Promise.all([first, second, third]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(one.get('b')?.username).toBe('user-b');
    expect(two.get('a')?.username).toBe('user-a');
    expect(three.get('a')?.username).toBe('user-a');
  });
});
