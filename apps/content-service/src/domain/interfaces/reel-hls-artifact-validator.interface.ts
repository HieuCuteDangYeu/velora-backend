import type { ReelHlsReplacementPlan } from '@common/content/reel-hls-replacement';

export interface IReelHlsArtifactValidator {
  validate(plan: ReelHlsReplacementPlan): Promise<void>;
}
