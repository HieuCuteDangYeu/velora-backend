import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID, createHash } from 'crypto';
import { RefreshTokenUseCase } from '../../application/use-cases/refresh-token.use-case';
import { AuthRepository } from './auth.repository';
import { PrismaService } from '../prisma/prisma.service';

const databaseUrl = process.env.AUTH_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

// AUTH_TEST_DATABASE_URL must point to a disposable, schema-initialized database.
integration('AuthRepository PostgreSQL integration', () => {
  let prisma: PrismaService;
  let repository: AuthRepository;
  const userId = 'rolling-test-' + randomUUID();

  beforeAll(async () => {
    prisma = new PrismaService({ datasources: { db: { url: databaseUrl! } } });
    await prisma.$connect();
    repository = new AuthRepository(
      prisma,
      new ConfigService({ JWT_SECRET: 'integration-only-secret' }),
    );
  });

  const createRefreshUseCase = (jwt: JwtService) =>
    new RefreshTokenUseCase(
      repository,
      {
        findById: jest.fn().mockResolvedValue({
          id: userId,
          email: 'integration@example.com',
          fullName: 'Integration User',
          username: 'integration-user',
          isVerified: true,
          picture: null,
        }),
      } as never,
      { setUserRoles: jest.fn() } as never,
      jwt,
      { recordRequest: jest.fn(), recordRefresh: jest.fn() } as never,
    );

  afterAll(async () => {
    await prisma.refreshToken.deleteMany({ where: { userId } });
    await prisma.$disconnect();
  });

  it('has removed the legacy column after migration', async () => {
    const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'RefreshToken'
        AND column_name = 'absoluteExpiresAt'
    `;
    expect(columns).toEqual([]);
  });

  it('persists rolling expiry and hashes/encrypts refresh tokens', async () => {
    const raw = 'login-' + randomUUID();
    const expiry = new Date(Date.now() + 90 * 86400000);
    const created = await repository.createRefreshToken(userId, raw, expiry);
    const row = await prisma.refreshToken.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.expiresAt).toEqual(expiry);
    expect(row.token).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(row.encryptedToken).not.toContain(raw);
    expect((await repository.findRefreshToken(raw))?.id).toBe(created.id);
  });

  it('rotates typed tokens once across concurrent same-ID refreshes and recovers retries', async () => {
    const jwt = new JwtService({ secret: 'integration-only-secret' });
    const oldRefreshToken = await jwt.signAsync(
      { sub: userId, tokenType: 'refresh' },
      { expiresIn: 86400, jwtid: randomUUID() },
    );
    const stored = await repository.createRefreshToken(
      userId,
      oldRefreshToken,
      new Date(Date.now() + 86400000),
    );
    const useCase = createRefreshUseCase(jwt);
    const requestId = randomUUID();
    const results = await Promise.all(
      [1, 2].map(() => useCase.execute(oldRefreshToken, requestId)),
    );
    expect(results[0].refreshToken).toBe(results[1].refreshToken);
    expect(
      jwt.verify<{ tokenType: string }>(results[0].accessToken).tokenType,
    ).toBe('access');
    expect(
      jwt.verify<{ tokenType: string }>(results[0].refreshToken).tokenType,
    ).toBe('refresh');
    expect(
      (
        await prisma.refreshToken.findUniqueOrThrow({
          where: { id: stored.id },
        })
      ).revoked,
    ).toBe(true);
    const replacement = await repository.findRefreshToken(
      results[0].refreshToken,
    );
    expect(replacement?.isActive()).toBe(true);
    expect(
      (await useCase.execute(oldRefreshToken, requestId)).refreshToken,
    ).toBe(results[0].refreshToken);
    await expect(
      repository.recoverRotatedRefreshToken(stored.id, requestId),
    ).resolves.toBe(results[0].refreshToken);
    await expect(
      repository.rotateRefreshToken(
        stored.id,
        'conflict',
        new Date(),
        'other-id',
      ),
    ).resolves.toBeNull();
    await prisma.refreshToken.update({
      where: { id: stored.id },
      data: { rotationRequestExpiresAt: new Date(Date.now() - 1) },
    });
    await expect(
      repository.recoverRotatedRefreshToken(stored.id, requestId),
    ).resolves.toBeNull();
  });

  it('upgrades a legacy untyped raw refresh row and rotates it to typed tokens', async () => {
    const jwt = new JwtService({ secret: 'integration-only-secret' });
    const legacyRefreshToken = await jwt.signAsync(
      { sub: userId },
      { expiresIn: 86400, jwtid: randomUUID() },
    );
    const legacy = await repository.createRefreshToken(
      userId,
      legacyRefreshToken,
      new Date(Date.now() + 86400000),
    );
    await prisma.refreshToken.update({
      where: { id: legacy.id },
      data: { token: legacyRefreshToken, encryptedToken: null },
    });

    const result = await createRefreshUseCase(jwt).execute(
      legacyRefreshToken,
      randomUUID(),
    );
    const upgraded = await prisma.refreshToken.findUniqueOrThrow({
      where: { id: legacy.id },
    });
    expect(upgraded.token).toBe(
      createHash('sha256').update(legacyRefreshToken).digest('hex'),
    );
    expect(upgraded.encryptedToken).toBeTruthy();
    expect(
      jwt.verify<{ tokenType: string }>(result.accessToken).tokenType,
    ).toBe('access');
    expect(
      jwt.verify<{ tokenType: string }>(result.refreshToken).tokenType,
    ).toBe('refresh');
  });

  it('logout-style revocation and revoke-all make recovery unavailable', async () => {
    const old = await repository.createRefreshToken(
      userId,
      'logout-' + randomUUID(),
      new Date(Date.now() + 86400000),
    );
    const result = await repository.rotateRefreshToken(
      old.id,
      'replacement-' + randomUUID(),
      new Date(Date.now() + 90 * 86400000),
      'logout-request',
    );
    await repository.updateRefreshToken(result!.token.id, { revoked: true });
    expect(
      (await repository.findRefreshToken(result!.refreshToken))?.isActive(),
    ).toBe(false);
    await expect(
      repository.recoverRotatedRefreshToken(old.id, 'logout-request'),
    ).resolves.toBeNull();
    await repository.revokeAllUserTokens(userId);
    expect(
      await prisma.refreshToken.count({ where: { userId, revoked: false } }),
    ).toBe(0);
  });
});
