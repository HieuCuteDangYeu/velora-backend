import { Logger } from '@nestjs/common';
import { NEVER, of, Subject, throwError } from 'rxjs';
import { UserServiceAdapter } from './user-service.adapter';

describe('Concurrent participant hydration', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('shares an in-flight request for the same IDs, but reads fresh after completion', async () => {
    const response = new Subject<never>();
    const users = [{ id: 'a', fullName: 'Before' }];
    const send = jest
      .fn()
      .mockReturnValueOnce(response)
      .mockReturnValue(of(users));
    const adapter = new UserServiceAdapter({ send } as never);
    const first = adapter.findUsersByIds(['b', 'a']);
    const second = adapter.findUsersByIds(['a', 'b', 'a']);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('user.find_by_ids', ['a', 'b']);
    response.next(users as never);
    response.complete();
    expect(await first).toBe(users);
    expect(await second).toBe(users);
    await adapter.findUsersByIds(['a', 'b']);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not combine different participant sets or user validation', async () => {
    const send = jest.fn().mockReturnValue(of(null));
    const adapter = new UserServiceAdapter({ send } as never);
    await Promise.all([
      adapter.findUsersByIds(['a']),
      adapter.findUsersByIds(['b']),
      adapter.validateUsers(['a']),
    ]);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenCalledWith('user.validate_list', { ids: ['a'] });
  });

  it.each(['error', 'timeout'])(
    'releases the shared request after %s',
    async (kind) => {
      jest.useFakeTimers();
      jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const send = jest
        .fn()
        .mockReturnValueOnce(
          kind === 'timeout'
            ? NEVER
            : throwError(() => new Error('unavailable')),
        )
        .mockReturnValue(of({ id: 'a', email: 'test@example.com' }));
      const adapter = new UserServiceAdapter({ send } as never);
      const first = adapter.findUsersByIds(['a']);
      const second = adapter.findUsersByIds(['a']);
      await jest.advanceTimersByTimeAsync(5000);
      expect(await first).toBeNull();
      expect(await second).toBeNull();
      expect(send).toHaveBeenCalledTimes(1);
      expect(await adapter.findUsersByIds(['a'])).toMatchObject({ id: 'a' });
      expect(send).toHaveBeenCalledTimes(2);
    },
  );
});
