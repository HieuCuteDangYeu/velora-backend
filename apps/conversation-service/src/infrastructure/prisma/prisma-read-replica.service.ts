import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/conversation-client';
import {
  ConversationPrometheusMetricsService,
  type RoutedReadOperation,
  type RoutedReadTarget,
} from '../metrics/conversation-prometheus-metrics.service';
import { PrismaService } from './prisma.service';

// Reads that can run on a replica only need the message delegate for now.
export type ReadClient = Pick<PrismaClient, 'message'>;

const PREFERENCES = {
  secondarypreferred: 'secondaryPreferred',
  secondary: 'secondary',
  nearest: 'nearest',
} as const;

/** Returns the canonical Mongo read preference, or undefined when routing is off or invalid. */
export function parseReadPreference(
  value: string | undefined,
): (typeof PREFERENCES)[keyof typeof PREFERENCES] | undefined {
  const key = String(value ?? '')
    .trim()
    .toLowerCase();
  return (PREFERENCES as Record<string, string | undefined>)[key] as
    | (typeof PREFERENCES)[keyof typeof PREFERENCES]
    | undefined;
}

/**
 * Sets readPreference on a Mongo connection string. Only the query part is
 * touched, so credentials and the host list stay exactly as configured.
 */
export function withReadPreference(
  connectionString: string,
  preference: string,
): string {
  const queryStart = connectionString.indexOf('?');
  const base =
    queryStart === -1
      ? connectionString
      : connectionString.slice(0, queryStart);
  const params = new URLSearchParams(
    queryStart === -1 ? '' : connectionString.slice(queryStart + 1),
  );
  params.set('readPreference', preference);
  return `${base}?${params.toString()}`;
}

/**
 * Optional second Prisma client for stale-tolerant reads.
 *
 * Off by default: with CONVERSATION_READ_REPLICA_PREFERENCE unset every read
 * runs on the primary client and no second connection pool is created. When it
 * is set to secondaryPreferred, secondary or nearest, reads passed to read() go
 * to a client whose connection string carries that readPreference.
 *
 * Replica data can lag the primary by a few seconds, so only use read() for
 * data where that is harmless, and never for authorization or read-after-write
 * checks. A replica error or a missing row is always re-checked on the primary.
 */
@Injectable()
export class PrismaReadReplicaService implements OnModuleDestroy {
  private readonly logger = new Logger(PrismaReadReplicaService.name);
  private readonly replica?: PrismaClient;
  readonly preference?: string;

  constructor(
    private readonly primary: PrismaService,
    config: ConfigService,
    private readonly metrics: ConversationPrometheusMetricsService,
  ) {
    const requested = config.get<string>(
      'CONVERSATION_READ_REPLICA_PREFERENCE',
    );
    const preference = parseReadPreference(requested);
    const databaseUrl = config.get<string>('CONVERSATION_DATABASE_URL');

    if (requested && String(requested).trim() && !preference) {
      this.logger.warn(
        'CONVERSATION_READ_REPLICA_PREFERENCE is not one of secondaryPreferred, secondary, nearest; reads stay on the primary.',
      );
    }
    if (preference && !databaseUrl) {
      this.logger.warn(
        'CONVERSATION_READ_REPLICA_PREFERENCE is set but CONVERSATION_DATABASE_URL is missing; reads stay on the primary.',
      );
    }

    if (preference && databaseUrl) {
      this.preference = preference;
      this.replica = new PrismaClient({
        datasourceUrl: withReadPreference(databaseUrl, preference),
      });
      this.logger.log(`Read replica routing enabled (${preference}).`);
    }
  }

  get enabled(): boolean {
    return this.replica !== undefined;
  }

  async onModuleDestroy() {
    await this.replica?.$disconnect();
  }

  /**
   * Runs a read, on the replica when routing is enabled. With confirmMiss, a
   * null result is re-read on the primary because the replica may simply not
   * have received a fresh row yet.
   */
  async read<T>(
    operation: RoutedReadOperation,
    query: (client: ReadClient) => Promise<T>,
    options: { confirmMiss?: boolean } = {},
  ): Promise<T> {
    const startedAt = process.hrtime.bigint();
    const record = (target: RoutedReadTarget) =>
      this.metrics.recordRoutedRead(
        operation,
        target,
        Number(process.hrtime.bigint() - startedAt) / 1e9,
      );

    if (!this.replica) {
      const result = await query(this.primary);
      record('primary');
      return result;
    }

    let fromReplica: T;
    try {
      fromReplica = await query(this.replica);
    } catch (error) {
      this.logger.warn(
        `Replica read failed for ${operation}, using the primary: ${
          error instanceof Error
            ? error.message.slice(0, 200).replace(/\/\/[^@\s]+@/g, '//***@')
            : 'unknown error'
        }`,
      );
      const result = await query(this.primary);
      record('fallback');
      return result;
    }

    if (
      options.confirmMiss &&
      (fromReplica === null || fromReplica === undefined)
    ) {
      const result = await query(this.primary);
      record('miss');
      return result;
    }

    record('replica');
    return fromReplica;
  }
}
