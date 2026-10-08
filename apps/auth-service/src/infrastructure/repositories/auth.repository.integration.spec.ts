import { ConfigService } from '@nestjs/config';
import { randomUUID, createHash } from 'crypto';
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

  it('atomically returns one winner for concurrent same-ID rotation', async () => {
    const old = await repository.createRefreshToken(
      userId,
      'old-' + randomUUID(),
      new Date(Date.now() + 86400000),
    );
    const expiry = new Date(Date.now() + 90 * 86400000);
    const requestId = randomUUID();
    const candidates = ['a-' + randomUUID(), 'b-' + randomUUID()];
    const results = await Promise.all(
      candidates.map((token) =>
        repository.rotateRefreshToken(old.id, token, expiry, requestId),
      ),
    );
    expect(results.every(Boolean)).toBe(true);
    expect(results[0]?.token.id).toBe(results[1]?.token.id);
    expect(results[0]?.refreshToken).toBe(results[1]?.refreshToken);
    expect(candidates).toContain(results[0]?.refreshToken);
    const consumed = await prisma.refreshToken.findUniqueOrThrow({
      where: { id: old.id },
    });
    expect(consumed.revoked).toBe(true);
    expect(
      (await repository.findRefreshToken(results[0]!.refreshToken))
        ?.rotationRequestExpiresAt,
    ).toBeNull();
    await expect(
      repository.recoverRotatedRefreshToken(old.id, requestId),
    ).resolves.toBe(results[0]?.refreshToken);
    await expect(
      repository.rotateRefreshToken(old.id, 'conflict', expiry, 'other-id'),
    ).resolves.toBeNull();
    await prisma.refreshToken.update({
      where: { id: old.id },
      data: { rotationRequestExpiresAt: new Date(Date.now() - 1) },
    });
    await expect(
      repository.recoverRotatedRefreshToken(old.id, requestId),
    ).resolves.toBeNull();
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
