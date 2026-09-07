import { z } from 'zod';

const CROP_FLOAT_TOLERANCE = 1e-6;
export const MAX_REEL_TRIM_TIME_MS = 86_400_000;

const UnitIntervalSchema = z.number().finite().min(0).max(1);

export const ReelMediaCropSchema = z
  .object({
    version: z.literal(1),
    x: UnitIntervalSchema,
    y: UnitIntervalSchema,
    width: z.number().finite().positive().max(1),
    height: z.number().finite().positive().max(1),
    aspectRatio: z.literal('9:16'),
  })
  .strict()
  .superRefine((crop, context) => {
    if (crop.x >= 1) {
      context.addIssue({
        code: 'custom',
        path: ['x'],
        message: 'Crop must leave positive width inside the source',
      });
    }

    if (crop.y >= 1) {
      context.addIssue({
        code: 'custom',
        path: ['y'],
        message: 'Crop must leave positive height inside the source',
      });
    }

    if (crop.x + crop.width > 1 + CROP_FLOAT_TOLERANCE) {
      context.addIssue({
        code: 'custom',
        path: ['width'],
        message: 'Crop must not extend past the right source boundary',
      });
    }

    if (crop.y + crop.height > 1 + CROP_FLOAT_TOLERANCE) {
      context.addIssue({
        code: 'custom',
        path: ['height'],
        message: 'Crop must not extend past the bottom source boundary',
      });
    }
  })
  .transform((crop) => ({
    ...crop,
    width: Math.min(crop.width, 1 - crop.x),
    height: Math.min(crop.height, 1 - crop.y),
  }));

export const ReelMediaTrimSchema = z
  .object({
    version: z.literal(1),
    startMs: z.number().finite().min(0).max(MAX_REEL_TRIM_TIME_MS),
    endMs: z.number().finite().positive().max(MAX_REEL_TRIM_TIME_MS),
  })
  .strict()
  .superRefine((trim, context) => {
    if (trim.endMs <= trim.startMs) {
      context.addIssue({
        code: 'custom',
        path: ['endMs'],
        message: 'Trim end must be greater than trim start',
      });
    }

    if (trim.endMs - trim.startMs < 1000) {
      context.addIssue({
        code: 'custom',
        path: ['endMs'],
        message: 'Trim interval must be at least 1000ms',
      });
    }
  });

export const ReelMediaEditSchema = z.discriminatedUnion('framing', [
  z
    .object({
      framing: z.literal('fit'),
      crop: z.never().optional(),
      trim: ReelMediaTrimSchema.optional(),
    })
    .strict(),
  z
    .object({
      framing: z.literal('crop'),
      crop: ReelMediaCropSchema,
      trim: ReelMediaTrimSchema.optional(),
    })
    .strict(),
]);

export type ReelMediaCrop = z.infer<typeof ReelMediaCropSchema>;
export type ReelMediaEdit = z.infer<typeof ReelMediaEditSchema>;
