import { resolveReelPixelCrop } from './reel-media-crop';

const cropEdit = (input: {
  x: number;
  y: number;
  width: number;
  height: number;
}) => ({
  framing: 'crop' as const,
  crop: {
    version: 1 as const,
    ...input,
    aspectRatio: '9:16' as const,
  },
});

describe('resolveReelPixelCrop', () => {
  it.each([
    [1080, 1920, 0],
    [2160, 3840, 0],
    [1080, 1080, 0],
    [1920, 1080, 0],
    [3840, 2160, 0],
    [1920, 1080, 90],
    [1920, 1080, 270],
  ])(
    'keeps crop geometry bounded and even for %sx%s rotation %s',
    (width, height, rotation) => {
      const result = resolveReelPixelCrop(
        cropEdit({ x: 0.17, y: 0.11, width: 0.5, height: 0.7 }),
        { width, height, rotation },
      );

      expect(result).toBeDefined();
      expect(result!.x % 2).toBe(0);
      expect(result!.y % 2).toBe(0);
      expect(result!.width % 2).toBe(0);
      expect(result!.height % 2).toBe(0);

      const effectiveWidth =
        rotation === 90 || rotation === 270 ? height : width;
      const effectiveHeight =
        rotation === 90 || rotation === 270 ? width : height;
      const safeWidth = Math.floor(effectiveWidth / 2) * 2;
      const safeHeight = Math.floor(effectiveHeight / 2) * 2;

      expect(result!.x + result!.width).toBeLessThanOrEqual(safeWidth);
      expect(result!.y + result!.height).toBeLessThanOrEqual(safeHeight);
    },
  );

  it('swaps source dimensions for a 90 degree source', () => {
    expect(
      resolveReelPixelCrop(cropEdit({ x: 0, y: 0, width: 1, height: 1 }), {
        width: 1920,
        height: 1080,
        rotation: 90,
      }),
    ).toEqual({ x: 0, y: 0, width: 1080, height: 1920 });
  });

  it('swaps source dimensions for a 270 degree source', () => {
    expect(
      resolveReelPixelCrop(cropEdit({ x: 0, y: 0, width: 1, height: 1 }), {
        width: 1920,
        height: 1080,
        rotation: 270,
      }),
    ).toEqual({ x: 0, y: 0, width: 1080, height: 1920 });
  });

  it('clamps a full-frame-ish crop without moving it outside the source', () => {
    expect(
      resolveReelPixelCrop(
        cropEdit({ x: 0.0001, y: 0.0001, width: 0.9999, height: 0.9999 }),
        { width: 1920, height: 1080, rotation: 0 },
      ),
    ).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });
});
