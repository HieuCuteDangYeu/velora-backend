import {
  type AccessPublicKey,
  toPublicKeyObjects,
} from '@common/auth/access-token';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { lastValueFrom, timeout } from 'rxjs';
import type { KeyObject } from 'node:crypto';

const REFETCH_AFTER_MS = 30_000;

/** Holds auth-service's access-token public key so the gateway can check tokens itself. */
@Injectable()
export class AccessKeyProvider implements OnModuleInit {
  private readonly logger = new Logger(AccessKeyProvider.name);
  private keys: ReadonlyMap<string, KeyObject> = new Map();
  private lastAttemptAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    @Inject('AUTH_SERVICE') private readonly authClient: ClientProxy,
  ) {}

  async onModuleInit(): Promise<void> {
    // Not fatal: until the key arrives every request takes the authoritative path.
    await this.refresh();
  }

  current(): ReadonlyMap<string, KeyObject> {
    return this.keys;
  }

  /** Called when a token names an unknown key; at most one fetch per 30 s. */
  refreshSoon(): void {
    if (Date.now() - this.lastAttemptAt >= REFETCH_AFTER_MS)
      void this.refresh();
  }

  private refresh(): Promise<void> {
    this.inflight ??= this.fetch().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetch(): Promise<void> {
    this.lastAttemptAt = Date.now();
    try {
      const keys = await lastValueFrom(
        this.authClient
          .send<AccessPublicKey[]>('auth.access_public_keys', {})
          .pipe(timeout(5000)),
      );
      this.keys = toPublicKeyObjects(keys);
    } catch (error) {
      this.logger.warn(
        `Access public key unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
