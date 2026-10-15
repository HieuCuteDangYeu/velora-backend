const objectSpy = jest.fn();

// Count z.object() construction so we can prove the receipt schema is built once.
jest.mock('zod', () => {
  const actual = jest.requireActual<typeof import('zod')>('zod');
  const z = new Proxy(actual.z, {
    get(target, property, receiver): unknown {
      if (property === 'object') {
        return (...args: Parameters<typeof target.object>) => {
          objectSpy();
          return target.object(...args);
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  return { ...actual, z };
});

import { writeAuthorizedPreview } from './authorized-preview.writer';

const id = '507f1f77bcf86cd799439012';
const at = new Date('2026-10-09T12:00:00.123Z');
const receipt = {
  ok: 1,
  lastErrorObject: { n: 1, updatedExisting: true },
  value: {
    _id: { $oid: id },
    creator_id: 'sender',
    participantIds: ['sender', 'member'],
    isGroup: false,
    createdAt: { $date: '2026-10-01T00:00:00.000Z' },
    lastMessage: 'hello',
    lastMessageAt: { $date: at.toISOString() },
    updatedAt: { $date: at.toISOString() },
  },
};
const tx = () => ({
  $runCommandRaw: jest.fn().mockResolvedValue(receipt),
  conversation: { findUnique: jest.fn() },
});

describe('Authorized preview receipt schema', () => {
  it('builds the zod schemas at module load, not once per message', async () => {
    const builtAtLoad = objectSpy.mock.calls.length;
    expect(builtAtLoad).toBeGreaterThan(0);

    for (let i = 0; i < 5; i++) {
      await writeAuthorizedPreview(tx() as never, id, 'sender', 'hello', at);
    }

    expect(objectSpy.mock.calls.length).toBe(builtAtLoad);
  });

  it('still rejects a receipt that fails validation', async () => {
    const bad = tx();
    bad.$runCommandRaw.mockResolvedValue({ ...receipt, ok: 0 });
    await expect(
      writeAuthorizedPreview(bad as never, id, 'sender', 'hello', at),
    ).rejects.toMatchObject({ status: 500 });
  });
});
