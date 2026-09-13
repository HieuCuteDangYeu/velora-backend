import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ICallMediaEngine } from '../../domain/interfaces/call-media.engine.interface';
import { ICallSessionRepository } from '../../domain/interfaces/call-session.repository.interface';

@Injectable()
export class ProduceUseCase {
  constructor(
    @Inject('ICallMediaEngine') private readonly mediaEngine: ICallMediaEngine,
    @Inject('ICallSessionRepository')
    private readonly sessionRepository: ICallSessionRepository,
  ) {}

  async execute(
    callId: string,
    userId: string,
    transportId: string,
    kind: 'audio' | 'video',
    rtpParameters: Record<string, unknown>,
    requestId?: string,
  ) {
    const session = await this.sessionRepository.findByCallId(callId);
    if (!session) {
      throw new NotFoundException('Call not found');
    }

    if (session.status !== 'active') {
      throw new ForbiddenException(
        'Media can only be produced for an active call',
      );
    }

    if (kind === 'video' && session.callType !== 'VIDEO') {
      throw new ForbiddenException('Video cannot be produced for a voice call');
    }

    return this.mediaEngine.produce(
      callId,
      userId,
      transportId,
      kind,
      rtpParameters,
      requestId,
    );
  }
}
