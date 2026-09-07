import type { ReelMediaEdit } from '@common/content/schemas/reel-edit.schema';
import type {
  ReelSourceLengthClass,
  ReelSourceOrientation,
} from '@common/content/interfaces/reel-state.interface';
import type { ReelPlaybackPresentation } from '@common/content/interfaces/reel-response.interface';

export function resolveReelPlaybackPresentation(input: {
  mediaEdit?: ReelMediaEdit | null;
  sourceOrientation?: ReelSourceOrientation;
  sourceLengthClass?: ReelSourceLengthClass;
}): ReelPlaybackPresentation {
  if (input.mediaEdit?.framing === 'crop') {
    return 'PORTRAIT_COVER';
  }

  return input.sourceOrientation === 'LANDSCAPE' &&
    input.sourceLengthClass === 'LONG'
    ? 'FIT_WITH_LETTERBOX'
    : 'PORTRAIT_COVER';
}
