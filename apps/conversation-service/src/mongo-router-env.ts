// Sends every MongoDB client of this process (Prisma, the read-replica client and
// the native message writer) through a sharded-cluster router (mongos) when
// CONVERSATION_MONGO_ROUTER is set, e.g. "mongos:27017". The credentials and the
// database stay those of CONVERSATION_DATABASE_URL; only the host list changes and
// replica-set discovery is dropped, because a mongos is not a replica set member.
// Unset (the default) leaves the URL untouched, so removing the flag rolls back.
//
// This module must be imported before anything that reads the URL (Prisma and
// @nestjs/config copy it when their modules load), so main.ts imports it first.

export const MONGO_ROUTER_ENV = 'CONVERSATION_MONGO_ROUTER';
export const MONGO_URL_ENV = 'CONVERSATION_DATABASE_URL';

const ROUTER_PATTERN =
  /^[A-Za-z0-9.-]+(:\d{1,5})?(,[A-Za-z0-9.-]+(:\d{1,5})?)*$/;

// Options that only make sense against a replica set.
const REPLICA_SET_ONLY_OPTIONS = new Set(['replicaset', 'directconnection']);

export function routeMongoUrl(url: string, router: string): string {
  const target = router.trim();
  if (!ROUTER_PATTERN.test(target)) {
    throw new Error(`${MONGO_ROUTER_ENV} must be host[:port][,host[:port]...]`);
  }

  const match =
    /^mongodb:\/\/(?:([^@/]*)@)?([^/?]+)(\/[^?]*)?(?:\?(.*))?$/.exec(url);
  if (!match) {
    throw new Error(`${MONGO_URL_ENV} is not a mongodb:// URL`);
  }

  const [, credentials, , path = '/', query] = match;
  const options = (query ?? '')
    .split('&')
    .filter(Boolean)
    .filter((option) => {
      const name = option.split('=')[0]?.toLowerCase() ?? '';
      return !REPLICA_SET_ONLY_OPTIONS.has(name);
    });

  return (
    'mongodb://' +
    (credentials !== undefined ? `${credentials}@` : '') +
    target +
    path +
    (options.length > 0 ? `?${options.join('&')}` : '')
  );
}

export function applyMongoRouter(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const router = env[MONGO_ROUTER_ENV]?.trim();
  const url = env[MONGO_URL_ENV];
  if (!router || !url) return false;

  env[MONGO_URL_ENV] = routeMongoUrl(url, router);
  return true;
}

if (applyMongoRouter()) {
  // Host only: the URL carries credentials and is never logged.
  console.log(
    `[mongo-router] MongoDB clients use the router ${process.env[MONGO_ROUTER_ENV]?.trim()}`,
  );
}
