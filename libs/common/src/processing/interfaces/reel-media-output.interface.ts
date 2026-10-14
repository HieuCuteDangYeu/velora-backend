import type { ReelSourceLengthClass } from '@common/content/interfaces/reel-state.interface';
import type { ReelEncodingVariantOutput } from '@common/processing/interfaces/reel-encoding-variant.interface';

export interface ReelMediaChecksums {
  sourceSha256: string;
  hlsMasterSha256: string;
  thumbnailSha256: string;
  transcriptionAudioManifestSha256?: string;
  visualFrameManifestSha256?: string;
}

export interface ReelMediaOutput {
  hlsMasterKey: string;
  thumbnailKey: string;
  transcriptionAudioManifestKey?: string;
  visualFrameManifestKey?: string;
  sourceHasAudio: boolean;
  sourceLengthClass: ReelSourceLengthClass;
  variants: ReelEncodingVariantOutput[];
  hlsObjectCount: number;
  hlsTotalBytes: number;
  checksums: ReelMediaChecksums;
}
