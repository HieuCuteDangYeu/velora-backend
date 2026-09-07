import type { ReelMediaEdit } from '@common/content/schemas/reel-edit.schema';

export interface ReelPixelCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function getEffectiveVideoDimensions(input: {
  width?: number;
  height?: number;
  rotation?: number;
}): { width: number; height: number } | undefined {
  if (
    !Number.isFinite(input.width) ||
    !Number.isFinite(input.height) ||
    (input.width ?? 0) <= 0 ||
    (input.height ?? 0) <= 0
  ) {
    return undefined;
  }

  const width = input.width!;
  const height = input.height!;
  const rotation = normalizeRotation(input.rotation);

  return rotation === 90 || rotation === 270
    ? { width: height, height: width }
    : { width, height };
}

export function resolveReelPixelCrop(
  edit: ReelMediaEdit | null | undefined,
  source: {
    width?: number;
    height?: number;
    rotation?: number;
  },
): ReelPixelCrop | undefined {
  if (edit?.framing !== 'crop') {
    return undefined;
  }

  const dimensions = getEffectiveVideoDimensions(source);

  if (!dimensions) {
    return undefined;
  }

  const sourceWidth = toEvenDimension(dimensions.width);
  const sourceHeight = toEvenDimension(dimensions.height);
  const cropRight = edit.crop.x + edit.crop.width;
  const cropBottom = edit.crop.y + edit.crop.height;

  const x = Math.min(
    sourceWidth - 2,
    toEvenCoordinate(edit.crop.x * sourceWidth),
  );
  const y = Math.min(
    sourceHeight - 2,
    toEvenCoordinate(edit.crop.y * sourceHeight),
  );
  const right = Math.min(
    sourceWidth,
    Math.max(x + 2, toEvenCeil(cropRight * sourceWidth)),
  );
  const bottom = Math.min(
    sourceHeight,
    Math.max(y + 2, toEvenCeil(cropBottom * sourceHeight)),
  );

  return {
    x,
    y,
    width: right - x,
    height: bottom - y,
  };
}

export function formatReelPixelCropFilter(crop: ReelPixelCrop): string {
  return `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`;
}

function normalizeRotation(rotation?: number): number {
  if (!Number.isFinite(rotation)) {
    return 0;
  }

  return ((Math.round(rotation!) % 360) + 360) % 360;
}

function toEvenDimension(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

function toEvenCoordinate(value: number): number {
  return Math.max(0, Math.floor(value / 2) * 2);
}

function toEvenCeil(value: number): number {
  return Math.max(2, Math.ceil(value / 2) * 2);
}
