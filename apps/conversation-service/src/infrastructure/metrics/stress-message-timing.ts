import { Logger } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

type Stage =
  | 'queued'
  | 'transactionStarted'
  | 'transactionResolved'
  | 'persistFinished'
  | 'ackSubmitted'
  | 'recipientsSubmitted';

interface Timing {
  clientMessageId: string;
  receivedAt: string;
  startedAt: bigint;
  stages: Partial<Record<Stage, number>>;
  reported: boolean;
}

/** Match only Auth-verified fixture identities, never socket handshake input. */
export function stressFixtureNamespace(email: string): string | undefined {
  return /^(mu-[a-f0-9]{12})\.\d{3}@velora-stress\.invalid$/.exec(email)?.[1];
}

/** Metadata-only diagnostics. Submission does not mean network delivery. */
export class StressMessageTiming {
  private readonly context = new AsyncLocalStorage<Timing>();
  private readonly logger = new Logger(StressMessageTiming.name);
  private windowStartedAt = process.hrtime.bigint();
  private accepted = 0;

  constructor(private readonly limit = 5_000) {}

  run<T>(
    namespace: unknown,
    clientMessageId: unknown,
    startedAt: bigint,
    receivedAt: string,
    action: () => Promise<T>,
  ): Promise<T> {
    // Namespace must come from the already verified Auth response. The global
    // budget also bounds logging if a fixture account is misused.
    if (
      typeof namespace !== 'string' ||
      !/^mu-[a-f0-9]{12}$/.test(namespace) ||
      typeof clientMessageId !== 'string' ||
      !/^mu-[a-f0-9]{12}-[a-f0-9-]{36}-load-[a-f0-9-]{36}$/.test(
        clientMessageId,
      ) ||
      !clientMessageId.startsWith(`${namespace}-`)
    ) {
      return action();
    }
    if (process.hrtime.bigint() - this.windowStartedAt >= 600_000_000_000n) {
      this.windowStartedAt = process.hrtime.bigint();
      this.accepted = 0;
    }
    if (this.accepted >= this.limit) return action();
    this.accepted++;
    return this.context.run(
      {
        clientMessageId,
        receivedAt,
        startedAt,
        stages: {},
        reported: false,
      },
      action,
    );
  }

  mark(stage: Stage): void {
    this.captureMark(stage)();
  }

  captureMark(stage: Stage): () => void {
    const trace = this.context.getStore();
    return () => {
      if (!trace || trace.reported || trace.stages[stage] !== undefined) return;
      trace.stages[stage] =
        Number(process.hrtime.bigint() - trace.startedAt) / 1e6;
    };
  }

  report(outcome: 'ack_submitted' | 'failed'): void {
    const trace = this.context.getStore();
    if (!trace || trace.reported) return;
    trace.reported = true;
    try {
      this.logger.log(
        JSON.stringify({
          type: 'stress_message_timing',
          clientMessageId: trace.clientMessageId,
          receivedAt: trace.receivedAt,
          outcome,
          elapsedMs: trace.stages,
        }),
      );
    } catch {
      // Diagnostics must not change the message outcome.
    }
  }
}

export const stressMessageTiming = new StressMessageTiming();
