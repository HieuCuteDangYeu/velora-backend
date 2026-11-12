export type AiChatMemoryRole = 'user' | 'assistant';
export type AiChatMessageEventType = 'TEXT' | 'REEL_SHARE';

export interface AiChatMessageContext {
  role: AiChatMemoryRole;
  content: string;
  createdAt: string;
  eventType?: AiChatMessageEventType;
  /**
   * For `user` messages: whether the person this turn is for wrote it. A group
   * chat that includes the bot has several human authors, so only the
   * requester's own words may become that person's long-term memory.
   * Unset means the author is unknown (legacy callers) and is not filtered.
   */
  authorIsRequester?: boolean;
}

export interface AiChatMemoryContext {
  recentMessages: AiChatMessageContext[];
}
