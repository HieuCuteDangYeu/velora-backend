export const MESSAGE_PREVIEW_MAX_LENGTH = 200;

// The conversation list shows one line of the last message. Storing and
// broadcasting the whole body made every list page and sidebar event as large
// as the longest recent message.
export const truncatePreview = (
  text: string | null | undefined,
): string | null => {
  if (typeof text !== 'string') {
    return null;
  }

  // Count code points so a surrogate pair is never cut in half.
  const characters = Array.from(text);
  if (characters.length <= MESSAGE_PREVIEW_MAX_LENGTH) {
    return text;
  }

  return `${characters.slice(0, MESSAGE_PREVIEW_MAX_LENGTH - 1).join('')}…`;
};
