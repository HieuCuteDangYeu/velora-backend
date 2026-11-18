import { createNativeMessageWriter } from './native-message-writer.provider';

const metrics = { recordMongoCommand: jest.fn() };
const quiet = { error: jest.fn(), log: jest.fn() } as never;

describe('createNativeMessageWriter', () => {
  it.each([undefined, '', 'prisma', 'off'])(
    'stays on Prisma when the driver is %p',
    async (driver) => {
      const env = {
        CONVERSATION_MESSAGE_WRITE_DRIVER: driver,
        CONVERSATION_DATABASE_URL: 'mongodb://localhost/db',
      };
      await expect(
        createNativeMessageWriter(metrics, env, quiet),
      ).resolves.toBeNull();
    },
  );

  it('falls back to Prisma without a database URL', async () => {
    await expect(
      createNativeMessageWriter(
        metrics,
        { CONVERSATION_MESSAGE_WRITE_DRIVER: 'native' },
        quiet,
      ),
    ).resolves.toBeNull();
  });

  it.each(['0', '-1', '2.5', 'abc', ''])(
    'rejects the invalid pool size %p',
    async (size) => {
      await expect(
        createNativeMessageWriter(
          metrics,
          {
            CONVERSATION_MESSAGE_WRITE_DRIVER: 'native',
            CONVERSATION_DATABASE_URL: 'mongodb://localhost/db',
            CONVERSATION_MONGO_WRITE_POOL_SIZE: size,
          },
          quiet,
        ),
      ).rejects.toThrow('positive integer');
    },
  );

  it('falls back to Prisma when MongoDB cannot be reached', async () => {
    const result = await createNativeMessageWriter(
      metrics,
      {
        CONVERSATION_MESSAGE_WRITE_DRIVER: 'native',
        // Nothing listens here; selection gives up quickly.
        CONVERSATION_DATABASE_URL:
          'mongodb://127.0.0.1:1/db?serverSelectionTimeoutMS=300&connectTimeoutMS=300',
      },
      quiet,
    );
    expect(result).toBeNull();
  }, 15_000);
});
