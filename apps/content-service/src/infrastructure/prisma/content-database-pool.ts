/**
 * Pool size for each Prisma client in content-service.
 *
 * The production URL carries `connection_limit=1`, which serialises every query
 * and transaction of a client through one connection (12 simultaneous publishes
 * returned 9 x 500). The Aiven plan allows 20 connections in total (3 reserved),
 * so the size is bounded: content-service opens two clients, each using this.
 * Set CONTENT_DB_POOL_SIZE=1 to restore the previous behaviour.
 */
export const DEFAULT_CONTENT_DB_POOL_SIZE = 3;
const MAX_CONTENT_DB_POOL_SIZE = 6;

export function resolveContentDbPoolSize(
  value: string | undefined = process.env.CONTENT_DB_POOL_SIZE,
): number {
  const parsed = Number(value);
  if (!value || !Number.isInteger(parsed) || parsed < 1) {
    return DEFAULT_CONTENT_DB_POOL_SIZE;
  }
  return Math.min(parsed, MAX_CONTENT_DB_POOL_SIZE);
}

/** Replaces or appends `connection_limit` without re-encoding the rest of the URL. */
export function withConnectionLimit(url: string, limit: number): string {
  if (/([?&])connection_limit=[^&]*/.test(url)) {
    return url.replace(
      /([?&])connection_limit=[^&]*/,
      `$1connection_limit=${limit}`,
    );
  }
  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=${limit}`;
}

/** Constructor options for a content PrismaClient; undefined keeps Prisma's own env lookup. */
export function contentPrismaOptions(
  env: NodeJS.ProcessEnv = process.env,
): { datasources: { db: { url: string } } } | undefined {
  const url = env.CONTENT_DATABASE_URL;
  if (!url) return undefined;
  return {
    datasources: {
      db: {
        url: withConnectionLimit(
          url,
          resolveContentDbPoolSize(env.CONTENT_DB_POOL_SIZE),
        ),
      },
    },
  };
}
