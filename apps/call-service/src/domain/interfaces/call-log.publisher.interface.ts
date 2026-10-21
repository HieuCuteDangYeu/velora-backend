import type { CallLoggedEvent } from '@common/calls/call-history.types';

export abstract class ICallLogPublisher {
  /** Sends `call.logged` to conversation-service, which adds the chat row. */
  abstract publish(event: CallLoggedEvent): Promise<void>;
}
