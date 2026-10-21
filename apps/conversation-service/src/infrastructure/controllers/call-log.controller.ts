import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { z } from 'zod';

import { CallLogService } from '../../application/services/call-log.service';

const callLoggedEventSchema = z.object({
  callId: z.string().min(1),
  conversationId: z.string().min(1),
  callType: z.enum(['VOICE', 'VIDEO']),
  isGroupCall: z.boolean(),
  initiatorId: z.string().min(1),
  outcome: z.enum(['COMPLETED', 'MISSED', 'DECLINED', 'FAILED']),
  terminalReason: z.string().min(1).optional(),
  durationSec: z.number().int().nonnegative().optional(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  participants: z.array(
    z.object({
      userId: z.string().min(1),
      role: z.enum(['CALLER', 'CALLEE']),
      result: z.enum(['ANSWERED', 'MISSED', 'DECLINED', 'CANCELLED', 'FAILED']),
    }),
  ),
});

/** `call.logged` from call-service, one per finished call. */
@Controller()
export class CallLogController {
  private readonly logger = new Logger(CallLogController.name);

  constructor(private readonly callLogService: CallLogService) {}

  @EventPattern('call.logged')
  async handleCallLogged(@Payload() payload: unknown): Promise<void> {
    const parsed = callLoggedEventSchema.safeParse(payload);
    if (!parsed.success) {
      this.logger.warn('Discarding malformed call.logged event');
      return;
    }
    try {
      const recorded = await this.callLogService.record(parsed.data);
      if (!recorded) {
        this.logger.warn(
          `call.logged for a missing conversation call=${parsed.data.callId.slice(-12)}`,
        );
      }
    } catch (error) {
      // conversation_queue auto-acknowledges events; the stored call history
      // in call-service stays complete even if this chat row is lost.
      this.logger.warn(
        `call log row failed call=${parsed.data.callId.slice(-12)}: ${
          error instanceof Error ? error.name : 'unknown_error'
        }`,
      );
    }
  }
}
