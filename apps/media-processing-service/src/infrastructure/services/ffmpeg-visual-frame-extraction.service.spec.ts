import { buildVisualFrameFilter } from './ffmpeg-visual-frame-extraction.service';

describe('buildVisualFrameFilter', () => {
  const crop = { x: 320, y: 0, width: 608, height: 1080 };

  it('applies crop before periodic sampling', () => {
    expect(
      buildVisualFrameFilter({
        mode: 'periodic',
        intervalSeconds: 4,
        crop,
      }),
    ).toBe("crop=608:1080:320:0,fps=1/4:start_time=0,scale='min(1280,iw)':-2");
  });

  it('applies crop before scene selection', () => {
    expect(
      buildVisualFrameFilter({
        mode: 'scene',
        sceneThreshold: 0.35,
        crop,
      }),
    ).toBe(
      "crop=608:1080:320:0,select='gt(scene,0.35)',showinfo,scale='min(1280,iw)':-2",
    );
  });
});
