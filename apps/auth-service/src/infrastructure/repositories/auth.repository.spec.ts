import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { AuthRepository } from './auth.repository';

const ttl = 90 * 86400000;
type Row = {
  id: string;
  userId: string;
  revoked: boolean;
  createdAt: Date;
  expiresAt: Date;
  absoluteExpiresAt: Date | null;
  replacedByTokenId?: string | null;
  rotationRequestId?: string | null;
  rotationRequestExpiresAt?: Date | null;
  rotatedAt?: Date | null;
  token?: string;
  encryptedToken?: string | null;
};

const setup = () => {
  const rows = new Map<string, Row>();
  const delegate = {
    create: jest.fn(({ data }: { data: Row }) => {
      const row = {
        createdAt: new Date(),
        absoluteExpiresAt: null,
        replacedByTokenId: null,
        rotationRequestId: null,
        rotationRequestExpiresAt: null,
        rotatedAt: null,
        ...data,
      };
      rows.set(row.id ?? 'created', row);
      return Promise.resolve(row);
    }),
    findUnique: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(rows.get(where.id) ?? null),
    ),
    findUniqueOrThrow: jest.fn(({ where }: { where: { id: string } }) => {
      const row = rows.get(where.id);
      if (!row) throw new Error('not found');
      return Promise.resolve(row);
    }),
    updateMany: jest.fn(
      ({
        where,
        data,
      }: {
        where: { id?: string; userId?: string; revoked: boolean };
        data: Partial<Row>;
      }) => {
        let count = 0;
        for (const row of rows.values()) {
          if (
            (where.id === undefined || row.id === where.id) &&
            (where.userId === undefined || row.userId === where.userId) &&
            row.revoked === where.revoked
          ) {
            Object.assign(row, data);
            count++;
          }
        }
        return Promise.resolve({ count });
      },
    ),
  };
  const prisma = {
    refreshToken: delegate,
    $transaction: jest.fn(
      (
        fn: (transaction: {
          refreshToken: typeof delegate;
        }) => Promise<Row | null>,
      ) => fn({ refreshToken: delegate }),
    ),
  };
  const repository = new AuthRepository(
    prisma as never,
    new ConfigService({ JWT_SECRET: 'test-only-secret' }),
  );
  rows.set('old', {
    id: 'old',
    userId: 'user',
    revoked: false,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + ttl),
    absoluteExpiresAt: new Date(Date.now() - 86400000),
  });
  return { rows, delegate, prisma, repository };
};

describe('AuthRepository rolling rotation and recovery contract', () => {
  afterEach(() => jest.useRealTimers());

  it('stores new tokens hashed/encrypted with a null legacy cap', async () => {
    const { repository, delegate } = setup();
    const expiresAt = new Date(Date.now() + ttl);
    await repository.createRefreshToken('user', 'raw-refresh', expiresAt);
    const data = delegate.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      userId: 'user',
      expiresAt,
      absoluteExpiresAt: null,
      revoked: false,
    });
    expect(data.token).toBe(
      createHash('sha256').update('raw-refresh').digest('hex'),
    );
    expect(data.encryptedToken).not.toContain('raw-refresh');
    expect(data.encryptedToken!.split('.')).toHaveLength(3);
  });

  it('consumes once through transactional CAS and recovers the same winner for a concurrent identical request', async () => {
    const { repository, rows, delegate, prisma } = setup();
    const expiresAt = new Date(Date.now() + ttl);
    const results = await Promise.all([
      repository.rotateRefreshToken('old', 'candidate-a', expiresAt, 'request'),
      repository.rotateRefreshToken('old', 'candidate-b', expiresAt, 'request'),
    ]);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(delegate.updateMany.mock.calls[0][0].where).toEqual({
      id: 'old',
      revoked: false,
    });
    expect(delegate.create).toHaveBeenCalledTimes(1);
    expect(rows.get('old').revoked).toBe(true);
    expect(results[0]?.refreshToken).toBe('candidate-a');
    expect(results[1]?.refreshToken).toBe('candidate-a');
    expect(results[0]?.token.absoluteExpiresAt).toBeNull();
    expect(results[0]?.token.expiresAt).toEqual(expiresAt);
    await expect(
      repository.recoverRotatedRefreshToken('old', 'request'),
    ).resolves.toBe('candidate-a');
    await expect(
      repository.recoverRotatedRefreshToken('old', 'wrong-id'),
    ).resolves.toBeNull();
    await expect(
      repository.rotateRefreshToken('old', 'other', expiresAt, 'wrong-id'),
    ).resolves.toBeNull();
  });

  it('rejects recovery at the five-minute window boundary and later CAS retries', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-07T00:00:00Z'));
    const { repository } = setup();
    const expiresAt = new Date(Date.now() + ttl);
    await repository.rotateRefreshToken(
      'old',
      'replacement',
      expiresAt,
      'request',
    );
    jest.advanceTimersByTime(5 * 60000);
    await expect(
      repository.recoverRotatedRefreshToken('old', 'request'),
    ).resolves.toBeNull();
    await expect(
      repository.rotateRefreshToken('old', 'another', expiresAt, 'request'),
    ).resolves.toBeNull();
  });

  it.each(['revoked', 'expired', 'unencrypted'])(
    'rejects recovery when the replacement is %s',
    async (state) => {
      const { repository, rows } = setup();
      await repository.rotateRefreshToken(
        'old',
        'replacement',
        new Date(Date.now() + ttl),
        'request',
      );
      const row = rows.get(rows.get('old')!.replacedByTokenId!)!;
      if (state === 'revoked') row.revoked = true;
      if (state === 'expired') row.expiresAt = new Date(Date.now() - 1);
      if (state === 'unencrypted') row.encryptedToken = null;
      await expect(
        repository.recoverRotatedRefreshToken('old', 'request'),
      ).resolves.toBeNull();
    },
  );

  it('revoke-all prevents recovery of a rotated replacement', async () => {
    const { repository, rows } = setup();
    await repository.rotateRefreshToken(
      'old',
      'replacement',
      new Date(Date.now() + ttl),
      'request',
    );
    await repository.revokeAllUserTokens('user');
    expect([...rows.values()].every((row) => row.revoked)).toBe(true);
    await expect(
      repository.recoverRotatedRefreshToken('old', 'request'),
    ).resolves.toBeNull();
  });
});
