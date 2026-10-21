import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import type { CallLoggedEvent } from '@common/calls/call-history.types';
import { firstValueFrom, timeout } from 'rxjs';

import { ICallLogPublisher } from '../../domain/interfaces/call-log.publisher.interface';

@Injectable()
export class RabbitCallLogPublisher implements ICallLogPublisher {
  constructor(
    @Inject('CONVERSATION_SERVICE_RMQ') private readonly client: ClientProxy,
  ) {}

  async publish(event: CallLoggedEvent): Promise<void> {
    await firstValueFrom(
      this.client.emit('call.logged', event).pipe(timeout(5000)),
    );
  }
}
