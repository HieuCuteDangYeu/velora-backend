import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import { PublishCallAnswerOutboxUseCase } from '../../application/use-cases/publish-call-answer-outbox.use-case';
import { CallServiceRuntimeLease } from '../runtime/call-service-runtime-lease.service';

@Injectable()
export class CallAnswerOutboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CallAnswerOutboxWorker.name);
  private readonly intervalMs = Math.max(
    250,
    Number(process.env.CALL_ANSWER_OUTBOX_POLL_MS || 500) || 500,
  );
  private timer?: ReturnType<typeof setInterval>;
  private draining = false;

  constructor(
    private readonly publishOutbox: PublishCallAnswerOutboxUseCase,
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
      // Continue until caught up without turning one failing event into a loop:
      // a failed lease moves into the future and the next claim is empty.
      while (true) {
        // App shutdown is asynchronous after a lease loss. Do not publish an
        // outbox event from a process that no longer owns the call runtime.
        this.runtimeLease.assertHeld();
        if ((await this.publishOutbox.execute()) === 0) {
          break;
        }
      }
    } catch (error) {
      this.logger.warn(
        `call.answered outbox drain failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.draining = false;
    }
  }
}
