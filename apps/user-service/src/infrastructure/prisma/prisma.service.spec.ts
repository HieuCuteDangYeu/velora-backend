const construct = jest.fn();
jest.mock('@prisma/user-client', () => ({
  PrismaClient: class {
    constructor(options: unknown) {
      construct(options);
    }
  },
}));
import { PrismaService } from './prisma.service';

describe('User database connection budget', () => {
  const original = { ...process.env };
  beforeEach(() => {
    construct.mockClear();
    process.env.USER_DATABASE_URL =
      'postgresql://test:test@localhost/users?connection_limit=1&sslmode=require&pool_timeout=10';
    delete process.env.USER_DATABASE_CONNECTION_LIMIT;
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it('keeps the existing URL when no override is configured', () => {
    new PrismaService();
    expect(construct).toHaveBeenCalledWith({
      datasources: { db: { url: process.env.USER_DATABASE_URL } },
    });
  });
  it('overrides only the pool limit and preserves SSL and deadlines', () => {
    process.env.USER_DATABASE_CONNECTION_LIMIT = '2';
    new PrismaService();
    const options = construct.mock.calls[0][0] as {
      datasources: { db: { url: string } };
    };
    const url = new URL(options.datasources.db.url);
    expect(url.searchParams.get('connection_limit')).toBe('2');
    expect(url.searchParams.get('sslmode')).toBe('require');
    expect(url.searchParams.get('pool_timeout')).toBe('10');
  });
  it.each(['0', '-1', '2.5', '', 'NaN', '9007199254740992'])(
    'rejects invalid limit %s before initializing Prisma',
    (limit) => {
      process.env.USER_DATABASE_CONNECTION_LIMIT = limit;
      expect(() => new PrismaService()).toThrow('positive integer');
      expect(construct).not.toHaveBeenCalled();
    },
  );
});
