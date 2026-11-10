/**
 * Raised when the model server is saturated: more chat turns are in flight than it can
 * serve in a reasonable time. It is a fast, honest "try again shortly" instead of letting
 * the turn queue behind a busy model until a model timeout turns it into an opaque failure.
 */
export class ChatBusyError extends Error {
  readonly code = 'AI_BUSY';

  constructor(readonly retryAfterSeconds: number) {
    super('AI is busy');
    this.name = 'ChatBusyError';
  }
}
