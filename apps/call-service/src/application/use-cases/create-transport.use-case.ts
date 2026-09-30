import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ICallMediaEngine } from '../../domain/interfaces/call-media.engine.interface';
import { ICallSessionRepository } from '../../domain/interfaces/call-session.repository.interface';

@Injectable()
export class CreateTransportUseCase {
  constructor(
    @Inject('ICallMediaEngine') private readonly mediaEngine: ICallMediaEngine,
    @Inject('ICallSessionRepository')
    private readonly sessionRepository: ICallSessionRepository,
  ) {}

  async execute(callId: string, userId: string, direction: 'send' | 'recv') {
    const session = await this.sessionRepository.findByCallId(callId);
    if (!session) {
      throw new NotFoundException('Call not found');
    }

    if (!session.participantIds.includes(userId)) {
      throw new ForbiddenException('You are not part of this call');
    }

    if (
      session.isGroupCall &&
      userId !== session.initiatorId &&
      !session.groupConfirmedAnswerActionIds[userId]
    ) {
      throw new ForbiddenException('Group call invitation is not confirmed');
    }

    if (direction === 'send') {
      return this.mediaEngine.createSendTransport(callId, userId);
    }

    return this.mediaEngine.createRecvTransport(callId, userId);
  }
}
