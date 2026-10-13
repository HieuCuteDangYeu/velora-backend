import { BadRequestException } from '@nestjs/common';
import type { CreateMessageDto } from '@common/conversation/dtos/create-message.dto';

export const MAX_MESSAGE_CONTENT_LENGTH = 4000;
export const MAX_MESSAGE_MEDIA_BYTES = 16 * 1024;
export const MAX_CLIENT_MESSAGE_ID_LENGTH = 200;

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
const MESSAGE_TYPES = ['text', 'image', 'video', 'file', 'call', 'reel'];
const SIGNAL_TYPES = [0, 1, 3];
// Attachments uploaded through the chat media pipeline always live on the CDN.
// Reel shares carry reel playback URLs and local thumbnails, so they are left
// to their own producer.
const CDN_MEDIA_TYPES = ['image', 'video', 'file'];

const reject = (message: string): never => {
  throw new BadRequestException(message);
};

// Origins (scheme + host + port) that chat attachments may point at. Returns
// null when none is configured, which disables the URL check rather than
// rejecting every attachment on a misconfigured deployment.
export const resolveAllowedMediaOrigins = (
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> | null => {
  const origins = new Set<string>();
  const candidates = [
    env.R2_PUBLIC_DOMAIN,
    ...(env.CHAT_MEDIA_EXTRA_ORIGINS ?? '').split(','),
  ];

  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (!value) continue;
    try {
      origins.add(new URL(value).origin);
    } catch {
      // An unparsable entry cannot match anything.
    }
  }

  return origins.size > 0 ? origins : null;
};

const isAllowedMediaUrl = (
  value: unknown,
  allowedOrigins: ReadonlySet<string>,
): boolean => {
  if (typeof value !== 'string') {
    return false;
  }

  try {
    const url = new URL(value);
    return !url.username && !url.password && allowedOrigins.has(url.origin);
  } catch {
    return false;
  }
};

const assertValidMedia = (
  media: unknown,
  type: string,
  allowedOrigins: ReadonlySet<string> | null,
): void => {
  if (media === undefined || media === null) {
    return;
  }

  if (typeof media !== 'object' || Array.isArray(media)) {
    reject('Invalid media');
  }

  // Reel shares carry reel metadata of any size (transcripts, series) and
  // their own URLs, so they are deliberately left unchecked here.
  if (!CDN_MEDIA_TYPES.includes(type)) {
    return;
  }

  if (Buffer.byteLength(JSON.stringify(media)) > MAX_MESSAGE_MEDIA_BYTES) {
    reject('Media is too large');
  }

  if (!allowedOrigins) {
    return;
  }

  const { fileUrl, thumbnailUrl } = media as Record<string, unknown>;
  if (!isAllowedMediaUrl(fileUrl, allowedOrigins)) {
    reject('Invalid media URL');
  }
  if (
    thumbnailUrl !== undefined &&
    thumbnailUrl !== null &&
    !isAllowedMediaUrl(thumbnailUrl, allowedOrigins)
  ) {
    reject('Invalid media thumbnail URL');
  }
};

// Chat sends arrive over a websocket, where no pipe validates the body, so the
// use case is the one place both the socket and the HTTP path pass through.
export const assertValidMessagePayload = (
  dto: CreateMessageDto,
  allowedMediaOrigins: ReadonlySet<string> | null,
): void => {
  if (!dto || typeof dto !== 'object') {
    reject('Invalid message');
  }

  if (
    typeof dto.conversationId !== 'string' ||
    !OBJECT_ID_PATTERN.test(dto.conversationId)
  ) {
    reject('Invalid conversation ID');
  }

  if (typeof dto.content !== 'string' || dto.content.length === 0) {
    reject('Content cannot be empty');
  }
  if (dto.content.length > MAX_MESSAGE_CONTENT_LENGTH) {
    reject('Message is too long');
  }

  const type = dto.type ?? 'text';
  if (typeof type !== 'string' || !MESSAGE_TYPES.includes(type)) {
    reject('Invalid message type');
  }

  if (
    dto.signalType !== undefined &&
    !SIGNAL_TYPES.includes(dto.signalType as number)
  ) {
    reject('Invalid signalType');
  }

  if (
    dto.clientMessageId !== undefined &&
    (typeof dto.clientMessageId !== 'string' ||
      dto.clientMessageId.length > MAX_CLIENT_MESSAGE_ID_LENGTH)
  ) {
    reject('Invalid clientMessageId');
  }

  if (
    dto.replyToId !== undefined &&
    dto.replyToId !== null &&
    (typeof dto.replyToId !== 'string' ||
      !OBJECT_ID_PATTERN.test(dto.replyToId))
  ) {
    reject('Invalid reply target');
  }

  if (
    dto.registrationId !== undefined &&
    dto.registrationId !== null &&
    !Number.isInteger(dto.registrationId)
  ) {
    reject('Invalid registrationId');
  }

  assertValidMedia(dto.media, type, allowedMediaOrigins);
};
