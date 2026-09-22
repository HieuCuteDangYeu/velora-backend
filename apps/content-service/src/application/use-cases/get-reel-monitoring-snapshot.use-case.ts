import type { ReelMonitoringSnapshot } from '@common/content/dtos/reel-monitoring-snapshot.dto';
import type { IContentRepository } from '@content/domain/interfaces/content.repository.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class GetReelMonitoringSnapshotUseCase {
  constructor(
    @Inject('IContentRepository')
    private readonly contentRepository: IContentRepository,
  ) {}

  execute(): Promise<ReelMonitoringSnapshot> {
    return this.contentRepository.getReelMonitoringSnapshot();
  }
}
