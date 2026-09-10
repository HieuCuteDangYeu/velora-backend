import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import { PublishCallTerminalOutboxUseCase } from '../../application/use-cases/publish-call-terminal-outbox.use-case';
import { CallServiceRuntimeLease } from '../runtime/call-service-runtime-lease.service';

@Injectable()
export class CallTerminalOutboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CallTerminalOutboxWorker.name);
  private readonly intervalMs = Math.max(
    250,
    Number(process.env.CALL_TERMINAL_OUTBOX_POLL_MS || 500) || 500,
  );
  private timer?: ReturnType<typeof setInterval>;
  private draining = false;

  constructor(
    private readonly publishOutbox: PublishCallTerminalOutboxUseCase,
    private readonly runtimeLease: CallServiceRuntimeLease,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.runtimeLease.acquire();
    this.runtimeLease.assertHeld();
    this.timer = setInterval(() => {
      void this.drain();
    }, this.intervalMs);
    this.timer.unref?.();
    void this.drain();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (true) {
        this.runtimeLease.assertHeld();
        if ((await this.publishOutbox.execute()) === 0) {
          break;
        }
      }
    } catch (error) {
      this.logger.warn(
        `terminal call outbox drain failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.draining = false;
    }
  }
}
