export type ConversationSendMetricStatus = 'success' | 'error';

export interface IConversationMetrics {
  recordSend(
    status: ConversationSendMetricStatus,
    durationSeconds: number,
    created: boolean,
  ): void;
}
