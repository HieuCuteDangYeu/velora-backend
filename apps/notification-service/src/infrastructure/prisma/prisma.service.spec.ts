const construct = jest.fn();
const middleware = jest.fn();
jest.mock('@prisma/notification-client', () => ({
  PrismaClient: class {
    constructor(options: unknown) {
      construct(options);
    }
    $use = middleware;
  },
}));
import { PrismaService } from './prisma.service';

describe('Notification database connection budget', () => {
  const original = { ...process.env };
  beforeEach(() => {
    construct.mockClear();
    middleware.mockClear();
    process.env.NOTIFICATION_DATABASE_URL =
      'postgresql://test:test@localhost/notification?connection_limit=1&sslmode=require&pool_timeout=10';
    delete process.env.NOTIFICATION_DATABASE_CONNECTION_LIMIT;
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it('keeps the existing URL when no override is configured', () => {
    new PrismaService();
    expect(construct).toHaveBeenCalledWith({
      datasources: { db: { url: process.env.NOTIFICATION_DATABASE_URL } },
    });
  });
  it('overrides only the pool limit and preserves SSL and deadlines', () => {
    process.env.NOTIFICATION_DATABASE_CONNECTION_LIMIT = '2';
    new PrismaService();
    const options = construct.mock.calls[0][0] as {
      datasources: { db: { url: string } };
    };
    const url = new URL(options.datasources.db.url);
    expect(url.searchParams.get('connection_limit')).toBe('2');
    expect(url.searchParams.get('sslmode')).toBe('require');
    expect(url.searchParams.get('pool_timeout')).toBe('10');
  });
  it('rejects a missing database URL when a limit is configured', () => {
    delete process.env.NOTIFICATION_DATABASE_URL;
    process.env.NOTIFICATION_DATABASE_CONNECTION_LIMIT = '1';
    expect(() => new PrismaService()).toThrow(
      'NOTIFICATION_DATABASE_URL is required',
    );
    expect(construct).not.toHaveBeenCalled();
  });

  it('gates operations at a smaller URL pool limit without starting another client', async () => {
    new PrismaService();
    type Next = (params: unknown) => Promise<unknown>;
    const gate = middleware.mock.calls[0][0] as (
      params: unknown,
      next: Next,
    ) => Promise<unknown>;
    let release!: () => void;
    const first = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const second = jest.fn().mockResolvedValue('second');
    const running = gate({}, first);
    const waiting = gate({}, second);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    release();
    await running;
    await expect(waiting).resolves.toBe('second');
    expect(construct).toHaveBeenCalledTimes(1);
  });

  it.each(['0', '-1', '2.5', '', 'NaN', '9007199254740992'])(
    'rejects invalid limit %s before initializing Prisma',
    (limit) => {
      process.env.NOTIFICATION_DATABASE_CONNECTION_LIMIT = limit;
      expect(() => new PrismaService()).toThrow('positive integer');
      expect(construct).not.toHaveBeenCalled();
    },
  );
});
