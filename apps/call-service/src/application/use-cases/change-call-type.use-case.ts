import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { CallType } from '../../domain/entities/call-session.entity';
import { ICallMediaEngine } from '../../domain/interfaces/call-media.engine.interface';
import { ICallSessionRepository } from '../../domain/interfaces/call-session.repository.interface';

export type ChangeCallTypeResult = {
  callId: string;
  callType: CallType;
  changedByUserId: string;
  closedVideoProducerIds: string[];
};

@Injectable()
export class ChangeCallTypeUseCase {
  constructor(
    @Inject('ICallSessionRepository')
    private readonly sessionRepository: ICallSessionRepository,
    @Inject('ICallMediaEngine')
    private readonly mediaEngine: ICallMediaEngine,
  ) {}

  async execute(
    callId: string,
    userId: string,
    callType: CallType,
  ): Promise<ChangeCallTypeResult> {
    const session = await this.sessionRepository.findByCallId(callId);
    if (!session) {
      throw new NotFoundException('Call not found');
    }

    if (session.status !== 'active') {
      throw new ForbiddenException(
        'Call type can only change while the call is active',
      );
    }

    if (session.isGroupCall && callType === 'VIDEO') {
      throw new ForbiddenException('Group calls currently support voice only');
    }

    const allowedUsers = new Set([session.initiatorId, session.targetUserId]);
    if (!allowedUsers.has(userId)) {
      throw new ForbiddenException('You are not part of this call');
    }

    if (session.callType === callType) {
      return {
        callId,
        callType,
        changedByUserId: userId,
        closedVideoProducerIds: [],
      };
    }

    const closedVideoProducerIds: string[] = [];
    if (callType === 'VOICE') {
      const producers = await this.mediaEngine.listActiveProducers(callId);
      for (const producer of producers) {
        if (producer.kind !== 'video') {
          continue;
        }

        await this.mediaEngine.closeProducer(
          callId,
          producer.userId,
          producer.producerId,
        );
        closedVideoProducerIds.push(producer.producerId);
      }
    }

    session.callType = callType;
    session.updatedAt = new Date();
    await this.sessionRepository.save(session);

    return {
      callId,
      callType,
      changedByUserId: userId,
      closedVideoProducerIds,
    };
  }
}
