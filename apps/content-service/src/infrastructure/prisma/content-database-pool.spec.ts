import {
  contentPrismaOptions,
  DEFAULT_CONTENT_DB_POOL_SIZE,
  resolveContentDbPoolSize,
  withConnectionLimit,
} from './content-database-pool';

describe('content database pool size', () => {
  it('replaces connection_limit in place and keeps the rest of the URL untouched', () => {
    expect(
      withConnectionLimit(
        'postgres://user:p%40ss@host:17415/content-service?sslmode=require&connection_limit=1',
        3,
      ),
    ).toBe(
      'postgres://user:p%40ss@host:17415/content-service?sslmode=require&connection_limit=3',
    );
  });

  it('appends connection_limit when the URL has none', () => {
    expect(withConnectionLimit('postgres://h/db', 3)).toBe(
      'postgres://h/db?connection_limit=3',
    );
    expect(withConnectionLimit('postgres://h/db?sslmode=require', 3)).toBe(
      'postgres://h/db?sslmode=require&connection_limit=3',
    );
  });

  it('defaults, clamps and ignores invalid CONTENT_DB_POOL_SIZE values', () => {
    expect(resolveContentDbPoolSize(undefined)).toBe(
      DEFAULT_CONTENT_DB_POOL_SIZE,
    );
    expect(resolveContentDbPoolSize('abc')).toBe(DEFAULT_CONTENT_DB_POOL_SIZE);
    expect(resolveContentDbPoolSize('0')).toBe(DEFAULT_CONTENT_DB_POOL_SIZE);
    expect(resolveContentDbPoolSize('1')).toBe(1);
    expect(resolveContentDbPoolSize('50')).toBe(6);
  });

  it('leaves Prisma on its own env lookup when the URL is not configured', () => {
    expect(contentPrismaOptions({})).toBeUndefined();
    expect(
      contentPrismaOptions({
        CONTENT_DATABASE_URL: 'postgres://h/db?connection_limit=1',
        CONTENT_DB_POOL_SIZE: '2',
      }),
    ).toEqual({
      datasources: { db: { url: 'postgres://h/db?connection_limit=2' } },
    });
  });
});
