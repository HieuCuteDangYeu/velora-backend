import { HttpException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { SearchController } from './search.controller';

describe('SearchController combined search', () => {
  const request = { user: { id: 'viewer-1' } } as never;

  const build = (reelsLeg: () => unknown) => {
    const userClient = {
      send: jest.fn().mockReturnValue(of([{ id: 'u1', username: 'ann' }])),
    };
    const contentClient = {
      send: jest.fn().mockImplementation((pattern: string) => {
        if (pattern === 'content.search_reels') return reelsLeg();
        return of({ tags: [{ tag: 'pets', count: 3 }] });
      }),
    };
    const authors = {
      loadAuthorMap: jest.fn().mockResolvedValue(new Map()),
      resolveAuthor: jest.fn(),
    };
    return new SearchController(
      userClient as never,
      contentClient as never,
      { getOrThrow: () => 'https://cdn.velora.test' } as never,
      authors as never,
    );
  };

  it('still answers users and tags when the reel leg fails', async () => {
    const controller = build(() => throwError(() => new Error('pool timeout')));

    const result = await controller.search(request, {
      q: 'pets',
      type: 'all',
      limit: 12,
    });

    expect(result.reels).toEqual([]);
    expect(result.users).toHaveLength(1);
    expect(result.tags).toHaveLength(1);
    expect(result.counts).toEqual({ users: 1, reels: 0, tags: 1 });
  });

  it('keeps surfacing the error when only reels were requested', async () => {
    const controller = build(() => throwError(() => new Error('pool timeout')));

    await expect(
      controller.search(request, { q: 'pets', type: 'reels', limit: 12 }),
    ).rejects.toBeInstanceOf(HttpException);
  });
});
