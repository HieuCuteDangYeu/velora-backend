export type ChatImageUnreadableReason =
  | 'NOT_OWNED'
  | 'TOO_LARGE'
  | 'NOT_FOUND'
  | 'VISION_FAILED';

/**
 * A photo sent with a chat turn could not be read: it is not the requester's upload, it is too
 * large, it is missing from storage, or the vision provider failed. The turn is not answered
 * as if the photo were absent, because the answer would then ignore what the user asked about.
 */
export class ChatImageUnreadableError extends Error {
  readonly code = 'IMAGE_UNREADABLE';

  constructor(readonly reason: ChatImageUnreadableReason) {
    super(`Chat image could not be read: ${reason}`);
    this.name = 'ChatImageUnreadableError';
  }
}
