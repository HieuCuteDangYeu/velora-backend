import { ChatBusyError } from '@ai/domain/errors/chat-busy.error';
import type { IChatAdmission } from '@ai/domain/interfaces/chat-admission.interface';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface Waiter {
  grant: () => void;
  timer: NodeJS.Timeout;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/**
 * FIFO admission for chat turns, in process (ai-service runs one replica; with more, each
 * replica admits independently, which still bounds the load on its share).
 *
 *   AI_MAX_CONCURRENT_TURNS  turns running at once (default 2). The model server handles one
 *                            request at a time, so a second turn mostly overlaps the first
 *                            turn's retrieval and other non-model steps.
 *   AI_MAX_QUEUED_TURNS      turns allowed to wait for a slot (default 6); more are refused at once.
 *   AI_TURN_QUEUE_WAIT_MS    longest a turn may wait before it is refused (default 20000).
 */
@Injectable()
export class InProcessChatAdmissionAdapter implements IChatAdmission {
  private readonly logger = new Logger(InProcessChatAdmissionAdapter.name);
  private active = 0;
  private readonly waiters: Waiter[] = [];
  /** Moving average of how long a turn takes, to estimate when a retry will fit. */
  private averageTurnMs = 8_000;
  private lastRefusalLogAt = 0;

  constructor(private readonly config: ConfigService) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    const startedAt = Date.now();
    try {
      return await task();
    } finally {
      this.averageTurnMs =
        0.8 * this.averageTurnMs + 0.2 * (Date.now() - startedAt);
      this.release();
    }
  }

  private integer(key: string, fallback: number, min: number, max: number) {
    const parsed = Number(this.config.get<string>(key));
    return Number.isInteger(parsed) && parsed >= min
      ? Math.min(parsed, max)
      : fallback;
  }

  private acquire(): Promise<void> {
    const maxConcurrent = this.integer('AI_MAX_CONCURRENT_TURNS', 2, 1, 16);
    if (this.active < maxConcurrent && this.waiters.length === 0) {
      this.active += 1;
      return Promise.resolve();
    }

    const maxQueued = this.integer('AI_MAX_QUEUED_TURNS', 6, 0, 100);
    if (this.waiters.length >= maxQueued) {
      return Promise.reject(this.busy('queue full'));
    }

    const maxWaitMs = this.integer(
      'AI_TURN_QUEUE_WAIT_MS',
      20_000,
      100,
      120_000,
    );
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        grant: () => {
          clearTimeout(waiter.timer);
          this.active += 1;
          resolve();
        },
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(this.busy('waited too long'));
        }, maxWaitMs),
      };
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    this.active -= 1;
    this.waiters.shift()?.grant();
  }

  private busy(reason: string): ChatBusyError {
    const maxConcurrent = this.integer('AI_MAX_CONCURRENT_TURNS', 2, 1, 16);
    const retryAfterSeconds = clamp(
      Math.ceil(
        (this.averageTurnMs / 1000) *
          ((this.waiters.length + 1) / maxConcurrent),
      ),
      5,
      60,
    );
    // An overload can refuse many turns a second; log it at most once every 10 s.
    if (Date.now() - this.lastRefusalLogAt > 10_000) {
      this.lastRefusalLogAt = Date.now();
      this.logger.warn(
        `[AiAdmission] turn refused (${reason}) active=${this.active} queued=${this.waiters.length} retry_after_s=${retryAfterSeconds}`,
      );
    }
    return new ChatBusyError(retryAfterSeconds);
  }
}
