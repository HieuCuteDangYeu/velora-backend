import { resolveReelPlaybackPresentation } from './playback-presentation';

describe('resolveReelPlaybackPresentation', () => {
  it('keeps legacy long landscape reels letterboxed in fit mode', () => {
    expect(
      resolveReelPlaybackPresentation({
        sourceOrientation: 'LANDSCAPE',
        sourceLengthClass: 'LONG',
      }),
    ).toBe('FIT_WITH_LETTERBOX');
  });

  it('uses portrait cover for an explicit crop regardless of source orientation', () => {
    expect(
      resolveReelPlaybackPresentation({
        mediaEdit: {
          framing: 'crop',
          crop: {
            version: 1,
            x: 0.25,
            y: 0,
            width: 0.5,
            height: 1,
            aspectRatio: '9:16',
          },
        },
        sourceOrientation: 'LANDSCAPE',
        sourceLengthClass: 'LONG',
      }),
    ).toBe('PORTRAIT_COVER');
  });
});
