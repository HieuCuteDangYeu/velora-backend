import type {
  IReelUploadLeaseService,
  ReelUploadLeaseReservation,
} from '@media/domain/interfaces/reel-upload-lease.service.interface';
import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';

@Injectable()
export class ContentUploadLeaseAdapter implements IReelUploadLeaseService {
  constructor(
    @Inject('CONTENT_SERVICE_RMQ')
    private readonly contentClient: ClientProxy,
  ) {}

  async reserve(input: ReelUploadLeaseReservation): Promise<void> {
    await firstValueFrom(
      this.contentClient
        .send('content.reserve_reel_upload', input)
        .pipe(timeout(10_000)),
    );
  }
}
