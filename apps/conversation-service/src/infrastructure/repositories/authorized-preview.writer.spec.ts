import { writeAuthorizedPreview } from './authorized-preview.writer';

const id = '507f1f77bcf86cd799439012';
const at = new Date('2026-10-09T12:00:00.123Z');
const receipt = () => ({
  ok: 1,
  lastErrorObject: { n: 1, updatedExisting: true },
  value: {
    _id: { $oid: id },
    creator_id: 'sender',
    participantIds: ['sender', 'member'],
    isGroup: true,
    memberJoinedAt: { member: '2026-10-01T00:00:00.000Z' },
    createdAt: { $date: '2026-10-01T00:00:00.000Z' },
    lastMessage: 'hello',
    lastMessageAt: { $date: at.toISOString() },
    updatedAt: { $date: at.toISOString() },
  },
});
const harness = (result: unknown) => ({
  $runCommandRaw: jest.fn().mockResolvedValue(result),
  conversation: { findUnique: jest.fn() },
});

describe('Authorized preview receipt', () => {
  it('decodes actual BSON fields and missing nullable fields without a success-path read', async () => {
    const tx = harness(receipt());
    const result = await writeAuthorizedPreview(
      tx as never,
      id,
      'sender',
      'hello',
      at,
    );
    expect(result).toMatchObject({
      id,
      creatorId: 'sender',
      participantIds: ['sender', 'member'],
      name: null,
      picture: null,
      memberJoinedAt: { member: '2026-10-01T00:00:00.000Z' },
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      updatedAt: at,
      lastMessageAt: at,
    });
    expect(tx.conversation.findUnique).not.toHaveBeenCalled();
    expect(tx.$runCommandRaw).toHaveBeenCalledTimes(1);
    expect(tx.$runCommandRaw.mock.calls[0][0]).toMatchObject({
      query: { _id: { $oid: id }, participantIds: 'sender' },
      new: true,
      upsert: false,
    });
    expect(tx.$runCommandRaw.mock.calls[0][0]).not.toHaveProperty(
      'writeConcern',
    );
  });

  it('decodes canonical BSON dates', async () => {
    const r = receipt();
    r.value.updatedAt = {
      $date: { $numberLong: String(at.getTime()) },
    } as never;
    r.value.lastMessageAt = r.value.updatedAt;
    await expect(
      writeAuthorizedPreview(harness(r) as never, id, 'sender', 'hello', at),
    ).resolves.toMatchObject({ updatedAt: at, lastMessageAt: at });
  });

  it.each([
    [
      'wrong conversation',
      (r: any) => {
        r.value._id.$oid = '507f1f77bcf86cd799439013';
      },
    ],
    [
      'wrong audience',
      (r: any) => {
        r.value.participantIds = ['member'];
      },
    ],
    [
      'invalid audience',
      (r: any) => {
        r.value.participantIds = [12];
      },
    ],
    [
      'missing group flag',
      (r: any) => {
        delete r.value.isGroup;
      },
    ],
    [
      'invalid BSON date',
      (r: any) => {
        r.value.createdAt = { $date: 'bad' };
      },
    ],
    [
      'wrong timestamp',
      (r: any) => {
        r.value.updatedAt = { $date: '2026-10-08T00:00:00.000Z' };
      },
    ],
    [
      'wrong preview',
      (r: any) => {
        r.value.lastMessage = 'other';
      },
    ],
    [
      'wrong matched count',
      (r: any) => {
        r.lastErrorObject.n = 2;
      },
    ],
    [
      'insert receipt',
      (r: any) => {
        r.lastErrorObject.updatedExisting = false;
      },
    ],
    [
      'unexpected upsert',
      (r: any) => {
        r.lastErrorObject.upserted = { $oid: id };
      },
    ],
    [
      'null updated snapshot',
      (r: any) => {
        r.value = null;
      },
    ],
    [
      'ambiguous durability',
      (r: any) => {
        r.writeConcernError = { code: 64 };
      },
    ],
    [
      'write failure',
      (r: any) => {
        r.writeErrors = [];
      },
    ],
  ])('rejects %s before allowing message insertion', async (_name, mutate) => {
    const r = receipt();
    mutate(r);
    const tx = harness(r);
    await expect(
      writeAuthorizedPreview(tx as never, id, 'sender', 'hello', at),
    ).rejects.toMatchObject({ status: 500 });
    expect(tx.conversation.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null, 404],
    ['removed sender', { participantIds: ['member'] }, 403],
    ['inconsistent no-match', { participantIds: ['sender'] }, 500],
  ])(
    'retains error semantics for %s without inserting or upserting',
    async (_name, record, status) => {
      const tx = harness({
        ok: 1,
        lastErrorObject: { n: 0, updatedExisting: false },
        value: null,
      });
      tx.conversation.findUnique.mockResolvedValue(record);
      await expect(
        writeAuthorizedPreview(tx as never, id, 'sender', 'hello', at),
      ).rejects.toMatchObject({ status });
      expect(tx.conversation.findUnique).toHaveBeenCalledTimes(1);
    },
  );
});
