import { ForbiddenException, HttpException } from '@nestjs/common';
import {
  chooseOwner,
  memberId,
  zoneOfMember,
  ConversationWriteRouter,
  decodeWriteError,
  encodeWriteError,
  WriteRouterUnavailableError,
} from './conversation-write-router';
import {
  DuplicateClientMessageError,
  MessageWriteConflictError,
} from './native-message-writer';

/** A tiny in-memory Redis: sorted set for membership plus pub/sub between connections. */
class FakeBus {
  readonly members = new Map<string, number>();
  readonly channels = new Map<string, Set<FakeRedis>>();
}

class FakeRedis {
  private handlers: Array<(channel: string, raw: string) => void> = [];
  constructor(private readonly bus: FakeBus) {}
  duplicate() {
    return new FakeRedis(this.bus);
  }
  on(event: string, handler: (channel: string, raw: string) => void) {
    if (event === 'message') this.handlers.push(handler);
    return this;
  }
  subscribe(channel: string) {
    const set = this.bus.channels.get(channel) ?? new Set<FakeRedis>();
    set.add(this);
    this.bus.channels.set(channel, set);
    return Promise.resolve(1);
  }
  disconnect() {
    for (const set of this.bus.channels.values()) set.delete(this);
  }
  publish(channel: string, raw: string) {
    const listeners = this.bus.channels.get(channel) ?? new Set<FakeRedis>();
    for (const listener of listeners)
      setImmediate(() => listener.handlers.forEach((h) => h(channel, raw)));
    return Promise.resolve(listeners.size);
  }
  zadd(_key: string, score: number, member: string) {
    this.bus.members.set(member, score);
    return Promise.resolve(1);
  }
  zrem(_key: string, member: string) {
    this.bus.members.delete(member);
    return Promise.resolve(1);
  }
  zremrangebyscore(_key: string, _min: string, max: number) {
    for (const [member, score] of this.bus.members)
      if (score <= max) this.bus.members.delete(member);
    return Promise.resolve(0);
  }
  zrangebyscore(_key: string, min: number) {
    return Promise.resolve(
      [...this.bus.members].filter(([, s]) => s >= min).map(([m]) => m),
    );
  }
}

const silent = { log: jest.fn(), warn: jest.fn() };

async function cluster(
  handlers: Record<string, (writes: unknown[]) => Promise<unknown[]>>,
  requestTimeoutMs = 500,
  senderOnly: string[] = [],
) {
  const bus = new FakeBus();
  const routers = Object.fromEntries(
    Object.entries(handlers).map(([id, handler]) => [
      id,
      new ConversationWriteRouter(new FakeRedis(bus) as never, {
        selfId: id,
        handler,
        ownsConversations: !senderOnly.includes(id),
        requestTimeoutMs,
        heartbeatMs: 60_000,
        logger: silent,
      }),
    ]),
  );
  for (const router of Object.values(routers)) await router.start();
  // The first heartbeats ran before every replica had registered: refresh once more.
  for (const router of Object.values(routers))
    await (router as unknown as { beat(): Promise<void> }).beat();
  return { bus, routers };
}

describe('chooseOwner', () => {
  it('is deterministic and independent of member order', () => {
    const a = chooseOwner(['r1', 'r2', 'r3'], 'conv-1');
    expect(chooseOwner(['r3', 'r1', 'r2'], 'conv-1')).toBe(a);
  });

  it('spreads conversations over every replica', () => {
    const counts: Record<string, number> = { r1: 0, r2: 0, r3: 0, r4: 0 };
    for (let i = 0; i < 4000; i++)
      counts[chooseOwner(['r1', 'r2', 'r3', 'r4'], `conv-${i}`)!]++;
    for (const share of Object.values(counts)) {
      expect(share).toBeGreaterThan(800);
      expect(share).toBeLessThan(1200);
    }
  });

  it('moves only the leaving replica’s conversations', () => {
    let moved = 0;
    for (let i = 0; i < 2000; i++) {
      const before = chooseOwner(['r1', 'r2', 'r3'], `c${i}`)!;
      const after = chooseOwner(['r1', 'r2'], `c${i}`)!;
      if (before !== after) {
        expect(before).toBe('r3');
        moved++;
      }
    }
    expect(moved).toBeGreaterThan(0);
  });

  it('returns null without members', () => {
    expect(chooseOwner([], 'c')).toBeNull();
  });
});

describe('zone-aware ownership', () => {
  const zoneOf = (conversationId: string) =>
    conversationId.startsWith('L') ? 'lab2' : 'home';
  const members = [
    memberId('mac-1', 'home'),
    memberId('mac-2', 'home'),
    memberId('laptop-1', 'lab2'),
  ];

  it('builds and reads zone-prefixed member ids', () => {
    expect(memberId('r1')).toBe('r1');
    expect(memberId('r1', 'lab2')).toBe('lab2~r1');
    expect(zoneOfMember('lab2~r1')).toBe('lab2');
    expect(zoneOfMember('r1')).toBeNull();
  });

  it('gives every conversation to a replica of its own zone', () => {
    for (let i = 0; i < 200; i++) {
      expect(chooseOwner(members, `L${i}`, zoneOf)).toBe('lab2~laptop-1');
      expect(['home~mac-1', 'home~mac-2']).toContain(
        chooseOwner(members, `H${i}`, zoneOf),
      );
    }
  });

  it('falls back to every replica when the zone has none alive', () => {
    const macOnly = ['home~mac-1', 'home~mac-2'];
    for (let i = 0; i < 50; i++)
      expect(macOnly).toContain(chooseOwner(macOnly, `L${i}`, zoneOf));
  });

  it('ignores zones when the conversation has none', () => {
    expect(members).toContain(chooseOwner(members, 'x', () => null));
  });

  it('routes a forwarded write to the zone owner end to end', async () => {
    const written: string[] = [];
    const bus = new FakeBus();
    const make = (replica: string, zone: string) =>
      new ConversationWriteRouter(new FakeRedis(bus) as never, {
        selfId: memberId(replica, zone),
        zoneOf,
        handler: (writes) => {
          written.push(replica);
          return Promise.resolve(writes);
        },
        heartbeatMs: 60_000,
        logger: silent,
      });
    const mac = make('mac', 'home');
    const laptop = make('laptop', 'lab2');
    await mac.start();
    await laptop.start();
    for (const router of [mac, laptop])
      await (router as unknown as { beat(): Promise<void> }).beat();

    expect(mac.ownerOf('L-conv')).toBe('lab2~laptop');
    expect(laptop.ownerOf('H-conv')).toBe('home~mac');
    await expect(mac.forward('lab2~laptop', [{ n: 1 }])).resolves.toEqual([
      { n: 1 },
    ]);
    expect(written).toEqual(['laptop']);
    await mac.stop();
    await laptop.stop();
  });
});

describe('write error transport', () => {
  it.each([
    [new DuplicateClientMessageError(), DuplicateClientMessageError],
    [new MessageWriteConflictError(), MessageWriteConflictError],
    [new ForbiddenException('no'), ForbiddenException],
    [new HttpException('full', 429), HttpException],
  ])('keeps %p recognisable', (error, type) => {
    expect(decodeWriteError(encodeWriteError(error))).toBeInstanceOf(type);
  });

  it('keeps the status of an HTTP error', () => {
    const decoded = decodeWriteError(
      encodeWriteError(new HttpException('full', 429)),
    ) as HttpException;
    expect(decoded.getStatus()).toBe(429);
  });

  it('turns a Prisma unique violation into a duplicate', () => {
    const decoded = decodeWriteError(encodeWriteError({ code: 'P2002' }));
    expect(decoded).toBeInstanceOf(DuplicateClientMessageError);
  });

  it('turns anything else into a plain error', () => {
    expect(decodeWriteError(encodeWriteError(new Error('boom'))).message).toBe(
      'boom',
    );
  });
});

describe('ConversationWriteRouter', () => {
  afterEach(() => jest.clearAllMocks());

  it('does not route while it is the only replica', async () => {
    const { routers } = await cluster({ r1: jest.fn() });
    expect(routers.r1.ownerOf('conv')).toBeNull();
  });

  it('gives every replica the same owner for a conversation', async () => {
    const { routers } = await cluster({
      r1: jest.fn(),
      r2: jest.fn(),
      r3: jest.fn(),
    });
    const owners = new Set(
      Object.values(routers).map((router) => router.ownerOf('conv-42')),
    );
    expect(owners.size).toBe(1);
    expect(owners.has(null)).toBe(false);
  });

  it('runs the write on the owner and revives the date columns', async () => {
    const handler = jest.fn((writes: unknown[]) =>
      Promise.resolve(
        writes.map(() => [
          {
            id: 'm1',
            createdAt: new Date('2026-11-20T01:00:00.000Z'),
            recalledAt: null,
          },
          { id: 'c1', lastMessageAt: new Date('2026-11-20T01:00:00.000Z') },
        ]),
      ),
    );
    const { routers } = await cluster({ r1: jest.fn(), r2: handler });

    const results = (await routers.r1.forward('r2', [
      { data: { id: 'm1' } },
    ])) as Array<[Record<string, unknown>, Record<string, unknown>]>;

    expect(handler).toHaveBeenCalledWith([{ data: { id: 'm1' } }]);
    expect(results[0][0].createdAt).toEqual(
      new Date('2026-11-20T01:00:00.000Z'),
    );
    expect(results[0][0].recalledAt).toBeNull();
    expect(results[0][1].lastMessageAt).toBeInstanceOf(Date);
  });

  it('hands the owner’s error back to the sender', async () => {
    const { routers } = await cluster({
      r1: jest.fn(),
      r2: jest.fn().mockRejectedValue(new DuplicateClientMessageError()),
    });
    await expect(routers.r1.forward('r2', [{}])).rejects.toBeInstanceOf(
      DuplicateClientMessageError,
    );
  });

  it('reports an owner nobody listens to as unavailable at once', async () => {
    const { routers } = await cluster({ r1: jest.fn(), r2: jest.fn() });
    await expect(routers.r1.forward('gone', [{}])).rejects.toBeInstanceOf(
      WriteRouterUnavailableError,
    );
  });

  it('reports a silent owner as unavailable after the timeout', async () => {
    const { routers } = await cluster(
      {
        r1: jest.fn(),
        r2: jest.fn(() => new Promise<unknown[]>(() => undefined)),
      },
      30,
    );
    await expect(routers.r1.forward('r2', [{}])).rejects.toBeInstanceOf(
      WriteRouterUnavailableError,
    );
  });

  it('drops a replica from ownership once it stops', async () => {
    const { routers } = await cluster({
      r1: jest.fn(),
      r2: jest.fn(),
      r3: jest.fn(),
    });
    await routers.r3.stop();
    await (routers.r1 as unknown as { beat(): Promise<void> }).beat();
    expect(routers.r1.liveMembers()).toEqual(['r1', 'r2']);
  });

  describe('sender-only replica', () => {
    it('never owns a conversation and is never chosen as an owner', async () => {
      const { routers } = await cluster(
        { r1: jest.fn(), r2: jest.fn(), laptop: jest.fn() },
        500,
        ['laptop'],
      );
      expect(routers.r1.liveMembers()).toEqual(['r1', 'r2']);
      for (let i = 0; i < 200; i++)
        expect(['r1', 'r2']).toContain(routers.laptop.ownerOf(`c${i}`));
    });

    it('forwards every write, even with a single owner alive', async () => {
      const { routers } = await cluster(
        { r1: jest.fn(), laptop: jest.fn() },
        500,
        ['laptop'],
      );
      expect(routers.laptop.ownerOf('conv')).toBe('r1');
      expect(routers.r1.ownerOf('conv')).toBeNull();
    });

    it('writes locally when no owner is alive', async () => {
      const { routers } = await cluster({ laptop: jest.fn() }, 500, ['laptop']);
      expect(routers.laptop.ownerOf('conv')).toBeNull();
    });
  });
});
