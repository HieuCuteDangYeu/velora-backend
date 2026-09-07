import { CreateReelSchema } from './create-reel.dto';

const validCrop = {
  version: 1,
  x: 0.25,
  y: 0,
  width: 0.5,
  height: 1,
  aspectRatio: '9:16' as const,
};

describe('CreateReelSchema edit validation', () => {
  it('accepts legacy requests without edit metadata', () => {
    expect(
      CreateReelSchema.safeParse({ mediaKey: 'uploads/source.mp4' }).success,
    ).toBe(true);
  });

  it('accepts fit framing without a crop', () => {
    expect(
      CreateReelSchema.safeParse({
        mediaKey: 'uploads/source.mp4',
        edit: { framing: 'fit' },
      }).success,
    ).toBe(true);
  });

  it('accepts trim metadata on fit framing', () => {
    expect(
      CreateReelSchema.safeParse({
        mediaKey: 'uploads/source.mp4',
        edit: {
          framing: 'fit',
          trim: { version: 1, startMs: 1000, endMs: 5000 },
        },
      }).success,
    ).toBe(true);
  });

  it('rejects crop metadata on fit framing', () => {
    expect(
      CreateReelSchema.safeParse({
        mediaKey: 'uploads/source.mp4',
        edit: { framing: 'fit', crop: validCrop },
      }).success,
    ).toBe(false);
  });

  it('requires crop metadata for crop framing', () => {
    expect(
      CreateReelSchema.safeParse({
        mediaKey: 'uploads/source.mp4',
        edit: { framing: 'crop' },
      }).success,
    ).toBe(false);
  });

  it('accepts a valid crop and normalizes a tiny boundary tolerance', () => {
    const result = CreateReelSchema.safeParse({
      mediaKey: 'uploads/source.mp4',
      edit: {
        framing: 'crop',
        crop: { ...validCrop, x: 0.7, width: 0.3000005 },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.edit?.framing).toBe('crop');
      if (result.data.edit?.framing === 'crop') {
        expect(result.data.edit.crop.width).toBeCloseTo(0.3, 12);
      }
    }
  });

  it.each([
    ['x < 0', { ...validCrop, x: -0.01 }],
    ['y < 0', { ...validCrop, y: -0.01 }],
    ['width <= 0', { ...validCrop, width: 0 }],
    ['height <= 0', { ...validCrop, height: 0 }],
    ['x > 1', { ...validCrop, x: 1.01 }],
    ['y > 1', { ...validCrop, y: 1.01 }],
    ['x + width > 1', { ...validCrop, x: 0.6, width: 0.41 }],
    ['y + height > 1', { ...validCrop, y: 0.6, height: 0.41 }],
    ['unsupported version', { ...validCrop, version: 2 }],
    ['unsupported aspect ratio', { ...validCrop, aspectRatio: '1:1' }],
  ])('rejects %s', (_label, crop) => {
    expect(
      CreateReelSchema.safeParse({
        mediaKey: 'uploads/source.mp4',
        edit: { framing: 'crop', crop },
      }).success,
    ).toBe(false);
  });

  it.each([
    ['trim end <= start', { version: 1, startMs: 5000, endMs: 5000 }],
    ['trim under one second', { version: 1, startMs: 0, endMs: 999 }],
    ['trim negative start', { version: 1, startMs: -1, endMs: 2000 }],
    ['trim unsupported version', { version: 2, startMs: 0, endMs: 2000 }],
  ])('rejects %s', (_label, trim) => {
    expect(
      CreateReelSchema.safeParse({
        mediaKey: 'uploads/source.mp4',
        edit: { framing: 'fit', trim },
      }).success,
    ).toBe(false);
  });
});
