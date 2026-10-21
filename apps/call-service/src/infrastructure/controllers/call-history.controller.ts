import { Controller, Inject } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import {
  type ICallHistoryRepository,
  InvalidCallHistoryCursorError,
} from '../../domain/interfaces/call-history.repository.interface';

const DEFAULT_HISTORY_PAGE_SIZE = 30;

type CallHistoryRequest = {
  userId?: string;
  cursor?: string;
  limit?: number;
};

/** RPC for the gateway; userId always comes from the authenticated request. */
@Controller()
export class CallHistoryController {
  constructor(
    @Inject('ICallHistoryRepository')
    private readonly historyRepository: ICallHistoryRepository,
  ) {}

  @MessagePattern('call.get_history')
  async getHistory(@Payload() payload: CallHistoryRequest) {
    if (!payload?.userId) return { items: [], nextCursor: null };
    try {
      return await this.historyRepository.listForUser(payload.userId, {
        cursor: payload.cursor || undefined,
        limit: Number(payload.limit) || DEFAULT_HISTORY_PAGE_SIZE,
      });
    } catch (error) {
      if (error instanceof InvalidCallHistoryCursorError) {
        return { error: 'invalid_cursor' as const };
      }
      throw error;
    }
  }

  @MessagePattern('call.get_missed_count')
  async getMissedCount(@Payload() payload: CallHistoryRequest) {
    return {
      count: payload?.userId
        ? await this.historyRepository.countUnseenMissed(payload.userId)
        : 0,
    };
  }

  @MessagePattern('call.mark_missed_seen')
  async markMissedSeen(@Payload() payload: CallHistoryRequest) {
    return {
      updated: payload?.userId
        ? await this.historyRepository.markMissedSeen(
            payload.userId,
            new Date(),
          )
        : 0,
    };
  }
}
