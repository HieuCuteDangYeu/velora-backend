import { Controller, Inject, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import type { ICallMediaEngine } from '../../domain/interfaces/call-media.engine.interface';
import {
  MEDIA_ROOMS_LOST_EVENT,
  type MediaRoomsLostEvent,
} from '../../media-node/media-node.contract';
import { RemoteCallMediaEngine } from '../engines/remote-call-media.engine';
import { safeCallErrorCode } from '../gateways/call-debug';

/** Receives worker-death reports from media nodes (remote media mode). */
@Controller()
export class MediaNodeEventsController {
  private readonly logger = new Logger(MediaNodeEventsController.name);

  constructor(
    @Inject('ICallMediaEngine') private readonly mediaEngine: ICallMediaEngine,
  ) {}

  @EventPattern(MEDIA_ROOMS_LOST_EVENT)
  async handleRoomsLost(@Payload() event: MediaRoomsLostEvent): Promise<void> {
    if (!(this.mediaEngine instanceof RemoteCallMediaEngine)) return;
    try {
      await this.mediaEngine.handleRoomsLostEvent(event);
    } catch (error) {
      this.logger.error(
        `Failed to handle lost media rooms errorCode=${safeCallErrorCode(error)}`,
      );
    }
  }
}
