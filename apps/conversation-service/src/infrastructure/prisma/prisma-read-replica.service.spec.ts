const constructed: Array<{ datasourceUrl?: string }> = [];
const disconnect = jest.fn().mockResolvedValue(undefined);
jest.mock('@prisma/conversation-client', () => ({
  PrismaClient: class {
    $disconnect = disconnect;
    constructor(options: { datasourceUrl?: string }) {
      constructed.push(options);
    }
  },
}));

import {
  parseReadPreference,
  PrismaReadReplicaService,
  withReadPreference,
} from './prisma-read-replica.service';

const BASE_URL =
  'mongodb://app:p%40ss@mongo:27017/conversation_db?authSource=conversation_db&replicaSet=rs0';

function build(env: Record<string, string | undefined>) {
  const metrics = { recordRoutedRead: jest.fn() };
  const config = { get: (key: string) => env[key] };
  const primary = { name: 'primary' };
  const service = new PrismaReadReplicaService(
    primary as never,
    config as never,
    metrics as never,
  );
  return { service, metrics, primary };
}

describe('read replica connection string', () => {
  it('keeps credentials and hosts and only sets readPreference', () => {
    expect(withReadPreference(BASE_URL, 'secondaryPreferred')).toBe(
      'mongodb://app:p%40ss@mongo:27017/conversation_db?authSource=conversation_db&replicaSet=rs0&readPreference=secondaryPreferred',
    );
  });

  it('overrides an existing readPreference and handles a URL without a query', () => {
    expect(
      withReadPreference(`${BASE_URL}&readPreference=primary`, 'nearest'),
    ).toContain('readPreference=nearest');
    expect(withReadPreference('mongodb://a:b@h1:1,h2:2/db', 'secondary')).toBe(
      'mongodb://a:b@h1:1,h2:2/db?readPreference=secondary',
    );
  });

  it('only accepts known preferences, case-insensitively', () => {
    expect(parseReadPreference(' SecondaryPreferred ')).toBe(
      'secondaryPreferred',
    );
    expect(parseReadPreference('secondary')).toBe('secondary');
    expect(parseReadPreference('nearest')).toBe('nearest');
    for (const value of [undefined, '', 'primary', 'primaryPreferred', 'x']) {
      expect(parseReadPreference(value)).toBeUndefined();
    }
  });
});

describe('PrismaReadReplicaService', () => {
  beforeEach(() => {
    constructed.length = 0;
    disconnect.mockClear();
  });

  it('is off by default: reads use the primary and no second client exists', async () => {
    const { service, metrics, primary } = build({
      CONVERSATION_DATABASE_URL: BASE_URL,
    });
    const query = jest.fn().mockResolvedValue({ id: '1' });

    await expect(service.read('reaction_details', query)).resolves.toEqual({
      id: '1',
    });

    expect(service.enabled).toBe(false);
    expect(constructed).toHaveLength(0);
    expect(query).toHaveBeenCalledWith(primary);
    expect(metrics.recordRoutedRead).toHaveBeenCalledWith(
      'reaction_details',
      'primary',
      expect.any(Number),
    );
  });

  it.each(['primary', 'bogus'])(
    'stays off for the unsupported value %s',
    (value) => {
      const { service } = build({
        CONVERSATION_READ_REPLICA_PREFERENCE: value,
        CONVERSATION_DATABASE_URL: BASE_URL,
      });
      expect(service.enabled).toBe(false);
      expect(constructed).toHaveLength(0);
    },
  );

  it('stays off when the database URL is missing', () => {
    const { service } = build({
      CONVERSATION_READ_REPLICA_PREFERENCE: 'secondary',
    });
    expect(service.enabled).toBe(false);
    expect(constructed).toHaveLength(0);
  });

  it('routes the read to a replica client built from the same URL', async () => {
    const { service, metrics, primary } = build({
      CONVERSATION_READ_REPLICA_PREFERENCE: 'secondaryPreferred',
      CONVERSATION_DATABASE_URL: BASE_URL,
    });
    const query = jest.fn().mockResolvedValue({ id: '1' });

    await expect(service.read('reaction_details', query)).resolves.toEqual({
      id: '1',
    });

    expect(constructed).toEqual([
      {
        datasourceUrl: `${BASE_URL}&readPreference=secondaryPreferred`,
      },
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalledWith(primary);
    expect(metrics.recordRoutedRead).toHaveBeenCalledWith(
      'reaction_details',
      'replica',
      expect.any(Number),
    );
  });

  it('falls back to the primary when the replica read fails', async () => {
    const { service, metrics, primary } = build({
      CONVERSATION_READ_REPLICA_PREFERENCE: 'secondary',
      CONVERSATION_DATABASE_URL: BASE_URL,
    });
    const query = jest
      .fn()
      .mockRejectedValueOnce(new Error('Server selection timeout'))
      .mockResolvedValueOnce({ id: 'from-primary' });

    await expect(service.read('reaction_details', query)).resolves.toEqual({
      id: 'from-primary',
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenLastCalledWith(primary);
    expect(metrics.recordRoutedRead).toHaveBeenCalledWith(
      'reaction_details',
      'fallback',
      expect.any(Number),
    );
  });

  it('confirms a replica miss on the primary when asked to', async () => {
    const { service, metrics, primary } = build({
      CONVERSATION_READ_REPLICA_PREFERENCE: 'nearest',
      CONVERSATION_DATABASE_URL: BASE_URL,
    });
    const query = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'fresh-row' });

    await expect(
      service.read('reaction_details', query, { confirmMiss: true }),
    ).resolves.toEqual({ id: 'fresh-row' });

    expect(query).toHaveBeenLastCalledWith(primary);
    expect(metrics.recordRoutedRead).toHaveBeenCalledWith(
      'reaction_details',
      'miss',
      expect.any(Number),
    );
  });

  it('returns a replica miss as is when confirmMiss is not set', async () => {
    const { service } = build({
      CONVERSATION_READ_REPLICA_PREFERENCE: 'nearest',
      CONVERSATION_DATABASE_URL: BASE_URL,
    });
    const query = jest.fn().mockResolvedValue(null);

    await expect(service.read('reaction_details', query)).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('disconnects the replica client on shutdown', async () => {
    const { service } = build({
      CONVERSATION_READ_REPLICA_PREFERENCE: 'secondary',
      CONVERSATION_DATABASE_URL: BASE_URL,
    });
    await service.onModuleDestroy();
    expect(disconnect).toHaveBeenCalledTimes(1);

    const off = build({});
    await off.service.onModuleDestroy();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
