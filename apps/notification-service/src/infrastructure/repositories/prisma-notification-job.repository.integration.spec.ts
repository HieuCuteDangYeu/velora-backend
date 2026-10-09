import { PrismaClient, type Prisma } from '@prisma/notification-client';
import { randomUUID } from 'node:crypto';
import { ProcessNotificationJobUseCase } from '../../application/use-cases/process-notification-job.use-case';
import { PrismaNotificationJobRepository } from './prisma-notification-job.repository';
import { PrismaPushTokenRepository } from './prisma-push-token.repository';

const uri = process.env.NOTIFICATION_TEST_DATABASE_URL;
const integration = uri ? describe : describe.skip;
const skipNoToken = { skipNewMessageWithoutFcmToken: true };

integration('Notification claim on isolated PostgreSQL', () => {
  let prisma: PrismaClient<Prisma.PrismaClientOptions, 'query'>;
  let repository: PrismaNotificationJobRepository;
  let created = false;
  const queries: string[] = [];

  beforeAll(async () => {
    const url = new URL(uri!);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !/^\/velora_notification_test_[a-f0-9]{16}$/.test(url.pathname) ||
      (url.searchParams.get('schema') ?? 'public') !== 'public'
    ) {
      throw new Error(
        'Use a new isolated local velora_notification_test_<16 hex> database',
      );
    }
    prisma = new PrismaClient({
      datasources: { db: { url: uri! } },
      log: [{ level: 'query', emit: 'event' }],
    });
    prisma.$on('query', (event) => {
      // Retain command kinds only, never SQL parameters or token values.
      queries.push(event.query.trim().split(/\s/)[0]);
    });
    const existing = await prisma.$queryRaw<
      Array<{ jobs: string | null; tokens: string | null }>
    >`
      SELECT to_regclass('public.notification_jobs')::text AS jobs,
             to_regclass('public.push_tokens')::text AS tokens
    `;
    if (existing[0].jobs || existing[0].tokens)
      throw new Error('Test database is not empty');
    await prisma.$executeRawUnsafe(`CREATE TABLE notification_jobs (
      id text PRIMARY KEY, type text NOT NULL, recipient_user_id text NOT NULL,
      actor_user_id text, conversation_id text, message_id text, call_id text,
      title text NOT NULL, body text NOT NULL, data_json jsonb, expires_at timestamp(3),
      status text NOT NULL DEFAULT 'pending', idempotency_key text UNIQUE,
      attempt_count integer NOT NULL DEFAULT 0, next_attempt_at timestamp(3),
      last_error text, created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp(3) NOT NULL, sent_at timestamp(3)
    )`);
    created = true;
    await prisma.$executeRawUnsafe(`CREATE TABLE push_tokens (
      id text PRIMARY KEY, user_id text NOT NULL, provider text NOT NULL,
      platform text NOT NULL, token text NOT NULL, device_id text, app_version text,
      group_lifecycle_version integer NOT NULL DEFAULT 1, bundle_id text,
      delivery_environment text, is_active boolean NOT NULL DEFAULT true,
      last_seen_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp(3) NOT NULL, UNIQUE(provider, token)
    )`);
    await prisma.$executeRawUnsafe(
      'CREATE INDEX ON push_tokens (user_id, is_active)',
    );
    repository = new PrismaNotificationJobRepository(prisma as never);
  });

  afterAll(async () => {
    try {
      if (created) {
        await prisma.$executeRawUnsafe(
          'DROP TABLE IF EXISTS notification_jobs, push_tokens',
        );
      }
    } finally {
      await prisma?.$disconnect();
    }
  });

  beforeEach(async () => {
    await prisma.notificationJob.deleteMany();
    await prisma.pushToken.deleteMany();
    queries.length = 0;
  });

  const createJob = (type = 'NEW_MESSAGE', recipientUserId = 'recipient') =>
    prisma.notificationJob.create({
      data: { type, recipientUserId, title: 'Fixture', body: 'Fixture' },
    });
  const register = (
    provider = 'fcm',
    platform = 'android',
    isActive = true,
    userId = 'recipient',
  ) =>
    prisma.pushToken.create({
      data: { provider, platform, isActive, userId, token: randomUUID() },
    });

  it('durably skips a no-token message in one statement with no extra token read/write', async () => {
    const job = await createJob();
    const fcm = { send: jest.fn() };
    const apns = { send: jest.fn() };
    const useCase = new ProcessNotificationJobUseCase(
      repository,
      new PrismaPushTokenRepository(prisma as never),
      fcm,
      apns,
    );
    queries.length = 0;
    const result = await useCase.execute(job as never);
    expect(result.status).toBe('skipped');
    expect(queries).toEqual(['WITH']);
    expect(fcm.send).not.toHaveBeenCalled();
    expect(apns.send).not.toHaveBeenCalled();
    const saved = await prisma.notificationJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(saved).toMatchObject({
      status: 'skipped',
      attemptCount: 1,
      nextAttemptAt: null,
      sentAt: null,
      lastError: 'No active FCM tokens for recipient user',
    });
    expect(await repository.claimForProcessing(job.id, skipNoToken)).toBeNull();
  });

  it.each(['android', 'ios'])(
    'keeps normal delivery for active %s FCM registrations',
    async (platform) => {
      await register('fcm', platform);
      const job = await createJob();
      const fcm = { send: jest.fn().mockResolvedValue('provider-id') };
      const useCase = new ProcessNotificationJobUseCase(
        repository,
        new PrismaPushTokenRepository(prisma as never),
        fcm,
        { send: jest.fn() },
      );
      expect((await useCase.execute(job as never)).status).toBe('sent');
      expect(fcm.send).toHaveBeenCalledTimes(1);
      expect(
        await prisma.notificationJob.findUniqueOrThrow({
          where: { id: job.id },
        }),
      ).toMatchObject({ status: 'sent', attemptCount: 1 });
    },
  );

  it('does not treat inactive, other-user or APNs-only tokens as message FCM registrations', async () => {
    await register('fcm', 'android', false);
    await register('fcm', 'ios', true, 'other');
    await register('apns_voip', 'ios');
    const job = await createJob();
    expect(
      await repository.claimForProcessing(job.id, skipNoToken),
    ).toMatchObject({ status: 'skipped', attemptCount: 1 });
  });

  it.each(['INCOMING_CALL', 'CALL_STATE_UPDATE'])(
    'never applies a message no-token shortcut to %s',
    async (type) => {
      const job = await createJob(type);
      expect(
        await repository.claimForProcessing(job.id, skipNoToken),
      ).toMatchObject({ status: 'processing', attemptCount: 1 });
    },
  );

  it('preserves opt-out and gives only one concurrent claimant the processing lease', async () => {
    const job = await createJob();
    const results = await Promise.all([
      repository.claimForProcessing(job.id),
      repository.claimForProcessing(job.id),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.find(Boolean)).toMatchObject({
      status: 'processing',
      attemptCount: 1,
    });
  });

  it('gives concurrent no-token claimants only one terminal result and one attempt', async () => {
    const job = await createJob();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        repository.claimForProcessing(job.id, skipNoToken),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.find(Boolean)).toMatchObject({
      status: 'skipped',
      attemptCount: 1,
    });
    expect(
      (
        await prisma.notificationJob.findUniqueOrThrow({
          where: { id: job.id },
        })
      ).attemptCount,
    ).toBe(1);
  });

  it('respects future backoff and live leases, but reclaims due and stale jobs', async () => {
    for (const state of [
      {
        status: 'failed',
        nextAttemptAt: new Date(Date.now() + 60_000),
        eligible: false,
      },
      {
        status: 'failed',
        nextAttemptAt: new Date(Date.now() - 60_000),
        eligible: true,
      },
      { status: 'processing', updatedAt: new Date(), eligible: false },
      {
        status: 'processing',
        updatedAt: new Date(Date.now() - 360_000),
        eligible: true,
      },
    ]) {
      const { eligible, ...data } = state;
      const job = await createJob();
      await prisma.notificationJob.update({
        where: { id: job.id },
        data: { ...data, attemptCount: 2, lastError: 'prior failure' },
      });
      const result = await repository.claimForProcessing(job.id, skipNoToken);
      if (eligible)
        expect(result).toMatchObject({
          status: 'skipped',
          attemptCount: 3,
          nextAttemptAt: null,
        });
      else expect(result).toBeNull();
    }
  });

  it('preserves retry metadata on active-token claims and rejects terminal replays', async () => {
    await register();
    const job = await createJob();
    const due = new Date(Date.now() - 60_000);
    await prisma.notificationJob.update({
      where: { id: job.id },
      data: {
        status: 'failed',
        nextAttemptAt: due,
        lastError: 'prior failure',
        attemptCount: 2,
      },
    });
    expect(
      await repository.claimForProcessing(job.id, skipNoToken),
    ).toMatchObject({
      status: 'processing',
      attemptCount: 3,
      nextAttemptAt: due,
    });
    expect(
      (
        await prisma.notificationJob.findUniqueOrThrow({
          where: { id: job.id },
        })
      ).lastError,
    ).toBe('prior failure');
    await repository.markSent(job.id);
    expect(await repository.claimForProcessing(job.id, skipNoToken)).toBeNull();
    expect(
      await repository.claimForProcessing(
        "unknown-'); DROP TABLE push_tokens; --",
        skipNoToken,
      ),
    ).toBeNull();
    expect(await prisma.pushToken.count()).toBe(1);
  });

  it('sees a later token registration on later jobs without a negative cache', async () => {
    const first = await createJob();
    expect(
      await repository.claimForProcessing(first.id, skipNoToken),
    ).toMatchObject({ status: 'skipped' });
    await register();
    const second = await createJob();
    expect(
      await repository.claimForProcessing(second.id, skipNoToken),
    ).toMatchObject({ status: 'processing' });
    expect(
      await repository.claimForProcessing(first.id, skipNoToken),
    ).toBeNull();
  });

  it('still skips safely if the last token is deactivated after the processing claim', async () => {
    const token = await register();
    const job = await createJob();
    const claim = async (id: string) => {
      const result = await repository.claimForProcessing(id, skipNoToken);
      expect(result?.status).toBe('processing');
      await prisma.pushToken.update({
        where: { id: token.id },
        data: { isActive: false },
      });
      return result;
    };
    const fcm = { send: jest.fn() };
    const useCase = new ProcessNotificationJobUseCase(
      {
        claimForProcessing: claim,
        markSkipped: repository.markSkipped.bind(repository),
      } as never,
      new PrismaPushTokenRepository(prisma as never),
      fcm,
      { send: jest.fn() },
    );
    expect((await useCase.execute(job as never)).status).toBe('skipped');
    expect(fcm.send).not.toHaveBeenCalled();
    expect(
      (
        await prisma.notificationJob.findUniqueOrThrow({
          where: { id: job.id },
        })
      ).status,
    ).toBe('skipped');
  });
});
