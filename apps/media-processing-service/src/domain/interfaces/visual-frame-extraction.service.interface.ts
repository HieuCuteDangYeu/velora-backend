import type { ReelPixelCrop } from '@common/processing/reel-media-crop';
import type { ReelMediaTrim } from '@common/processing/reel-media-trim';

export interface ExtractedVisualFrame {
  outputPath: string;
  timestampMs: number;
  reason: 'PERIODIC' | 'SCENE_CHANGE';
}

export interface IVisualFrameExtractionService {
  extractCandidateFrames(input: {
    inputPath: string;
    outputDir: string;
    totalDurationMs: number;
    periodicIntervalMs: number;
    sceneThreshold: number;
    crop?: ReelPixelCrop;
    trim?: ReelMediaTrim;
  }): Promise<ExtractedVisualFrame[]>;
}
