import { applyMongoRouter, routeMongoUrl } from './mongo-router-env';

describe('routeMongoUrl', () => {
  it('swaps the host and drops replica-set discovery but keeps credentials and options', () => {
    expect(
      routeMongoUrl(
        'mongodb://app:s3cr%40t@mongo:27017/conversation_db?authSource=conversation_db&replicaSet=rs0&retryWrites=true',
        'mongos:27017',
      ),
    ).toBe(
      'mongodb://app:s3cr%40t@mongos:27017/conversation_db?authSource=conversation_db&retryWrites=true',
    );
  });

  it('handles several seed hosts, no credentials and directConnection', () => {
    expect(
      routeMongoUrl(
        'mongodb://a:27017,b:27017/db?directConnection=true&ReplicaSet=rs0',
        'mongos-1:27017,mongos-2:27017',
      ),
    ).toBe('mongodb://mongos-1:27017,mongos-2:27017/db');
  });

  it('rejects a malformed router or a non-mongodb URL', () => {
    expect(() =>
      routeMongoUrl('mongodb://mongo:27017/db', 'mongos:27017/db'),
    ).toThrow('CONVERSATION_MONGO_ROUTER');
    expect(() =>
      routeMongoUrl('mongodb+srv://cluster/db', 'mongos:27017'),
    ).toThrow('not a mongodb:// URL');
  });
});

describe('applyMongoRouter', () => {
  it('leaves the URL alone when the flag is unset or blank', () => {
    const env = {
      CONVERSATION_DATABASE_URL: 'mongodb://mongo:27017/db?replicaSet=rs0',
      CONVERSATION_MONGO_ROUTER: ' ',
    };
    expect(applyMongoRouter(env)).toBe(false);
    expect(env.CONVERSATION_DATABASE_URL).toBe(
      'mongodb://mongo:27017/db?replicaSet=rs0',
    );
  });

  it('rewrites the URL in place when the flag is set', () => {
    const env = {
      CONVERSATION_DATABASE_URL: 'mongodb://u:p@mongo:27017/db?replicaSet=rs0',
      CONVERSATION_MONGO_ROUTER: 'mongos:27017',
    };
    expect(applyMongoRouter(env)).toBe(true);
    expect(env.CONVERSATION_DATABASE_URL).toBe('mongodb://u:p@mongos:27017/db');
  });
});
