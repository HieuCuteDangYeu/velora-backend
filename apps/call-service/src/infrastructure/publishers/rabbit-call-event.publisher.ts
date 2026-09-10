import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import {
  CallLifecycleEvent,
  CallLifecyclePayload,
  ICallEventPublisher,
} from '../../domain/interfaces/call-event.publisher.interface';

@Injectable()
export class RabbitCallEventPublisher implements ICallEventPublisher {
  constructor(
    @Inject('NOTIFICATION_SERVICE_RMQ') private readonly client: ClientProxy,
  ) {}

  async publish(
    event: CallLifecycleEvent,
    payload: CallLifecyclePayload,
  ): Promise<void> {
    await firstValueFrom(this.client.emit(event, payload));
  }
}
