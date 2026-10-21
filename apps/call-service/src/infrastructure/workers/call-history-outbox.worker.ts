import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import { RecordCallHistoryOutboxUseCase } from '../../application/use-cases/record-call-history-outbox.use-case';
import { CallServiceRuntimeLease } from '../runtime/call-service-runtime-lease.service';
import { safeCallErrorCode } from '../gateways/call-debug';

@Injectable()
export class CallHistoryOutboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CallHistoryOutboxWorker.name);
  private readonly intervalMs = Math.max(
    250,
    Number(process.env.CALL_HISTORY_OUTBOX_POLL_MS || 1000) || 1000,
  );
  private timer?: ReturnType<typeof setInterval>;
  private draining = false;

  constructor(
    private readonly recordHistory: RecordCallHistoryOutboxUseCase,
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
        if ((await this.recordHistory.execute()) === 0) {
          break;
        }
      }
    } catch (error) {
      this.logger.warn(
        `call history outbox drain failed errorCode=${safeCallErrorCode(error)}`,
      );
    } finally {
      this.draining = false;
    }
  }
}
