/** Image formats the chat upload pipeline presigns and the vision providers read. */
export const CHAT_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type ChatImageMimeType = (typeof CHAT_IMAGE_MIME_TYPES)[number];

/** Folder media-service writes chat images to: `chat-images/{userId}/{uuid}.{ext}`. */
export const CHAT_IMAGE_KEY_FOLDER = 'chat-images';

/** Most images one AI turn may carry. The mobile composer sends one per message. */
export const MAX_CHAT_IMAGES_PER_AI_TURN = 3;

/**
 * Content the mobile composer stores for an image sent without a caption. It is not
 * a question, so the AI turn treats it as "no caption".
 */
export const CHAT_IMAGE_PLACEHOLDER_CONTENTS: readonly string[] = [
  '[Hình ảnh]',
];

/** The question the AI answers when a photo arrives without a caption. */
export const DEFAULT_IMAGE_ONLY_QUESTION =
  'Hãy tìm các reel Velora liên quan đến hình ảnh này.';

export const isChatImageMimeType = (
  value: unknown,
): value is ChatImageMimeType =>
  typeof value === 'string' &&
  (CHAT_IMAGE_MIME_TYPES as readonly string[]).includes(value);

/**
 * True only for a key this user's own chat upload produced. The bytes are read from
 * storage by key, so this check is what stops one user from making the AI read
 * another user's file (or any other object in the bucket).
 */
export const isChatImageKeyOwnedBy = (userId: string, key: string): boolean => {
  if (!userId || userId.includes('/') || typeof key !== 'string') return false;
  const prefix = `${CHAT_IMAGE_KEY_FOLDER}/${userId}/`;
  if (!key.startsWith(prefix)) return false;
  return /^[A-Za-z0-9-]+\.(jpe?g|png|webp)$/.test(key.slice(prefix.length));
};

/** The caption a user typed, or '' when the content is only the composer's placeholder. */
export const extractChatImageCaption = (
  content: string | undefined,
): string => {
  const trimmed = content?.trim() ?? '';
  return CHAT_IMAGE_PLACEHOLDER_CONTENTS.includes(trimmed) ? '' : trimmed;
};
