/** What the vision provider saw in a photo the user attached to a chat turn. */
export interface RagImageContext {
  description: string;
  ocrText?: string;
  objects: string[];
}

const MAX_CAPTION_CHARS_WITH_HINT = 500;

const collapse = (value: string): string =>
  // Square brackets are removed so a description can never close or fake the marker below.
  value.replace(/[[\]]/g, ' ').replace(/\s+/g, ' ').trim();

const clip = (value: string, maxChars: number): string =>
  value.length <= maxChars ? value : `${value.slice(0, maxChars - 1).trim()}…`;

/**
 * One line that tells the model what a photo shows. It comes from a vision model reading
 * user-supplied pixels, so it is data about the photo, never instructions.
 */
export const formatRagImageHint = (
  images: readonly RagImageContext[] | undefined,
  maxChars = 600,
): string => {
  if (!images?.length) return '';
  const perImage = Math.max(120, Math.floor(maxChars / images.length));
  return images
    .map((image, index) => {
      const parts = [collapse(image.description)];
      const text = image.ocrText ? collapse(image.ocrText) : '';
      if (text) parts.push(`readable text: "${text}"`);
      const objects = image.objects.map(collapse).filter(Boolean);
      if (objects.length) parts.push(`objects: ${objects.join(', ')}`);
      const label = images.length > 1 ? `image ${index + 1}: ` : '';
      return clip(label + parts.filter(Boolean).join('; '), perImage);
    })
    .join(' | ');
};

/** The user's message with the note about the photo appended, for the router and retrieval. */
export const withRagImageHint = (
  message: string,
  images: readonly RagImageContext[] | undefined,
  maxChars?: number,
): string => {
  const hint = formatRagImageHint(images, maxChars);
  // The router and planner bound the whole message, which would cut the note off a long caption.
  return hint
    ? `${clip(message, MAX_CAPTION_CHARS_WITH_HINT)}\n[Attached image shows: ${hint}]`
    : message;
};

/** Search terms taken from the photo, for finding reels that look like it. */
export const buildRagImageSearchQuery = (
  images: readonly RagImageContext[] | undefined,
): string => {
  if (!images?.length) return '';
  return clip(
    images
      .flatMap((image) => [image.description, ...image.objects.slice(0, 6)])
      .map(collapse)
      .filter(Boolean)
      .join(' '),
    200,
  );
};
