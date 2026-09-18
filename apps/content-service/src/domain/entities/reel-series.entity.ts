import type { ReelVisibility } from '@common/content/schemas/reel-visibility.schema';
import type { Reel } from './reel.entity';

export class ReelSeries {
  id!: string;
  ownerId!: string;
  title!: string;
  description?: string;
  visibility!: ReelVisibility;
  createdAt!: Date;
  updatedAt!: Date;
  reels: Reel[] = [];

  constructor(partial: Partial<ReelSeries> = {}) {
    Object.assign(this, partial);
  }
}
