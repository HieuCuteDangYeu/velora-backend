import type { AiChatMessageContext } from '@common/ai/interfaces/chat-memory-context.interface';

/**
 * The assistant's fixed replies: a scope redirect, an input refusal, a failure notice. They say
 * nothing about the user, and a small model that sees several of them in the history tends to
 * copy the last one instead of answering. Recall turns leave them out.
 */
const CANNED_PREFIXES = [
  'I can only help with Velora',
  'I can’t help with that request',
  'I could not verify that answer reliably',
  'I could not find that in our conversation',
  'I do not have that saved about you',
  'I do not have enough verified shared reel evidence',
  'Sorry, I couldn’t put together an answer',
];

export const isCannedAssistantReply = (
  message: Pick<AiChatMessageContext, 'role' | 'content'>,
): boolean =>
  message.role === 'assistant' &&
  CANNED_PREFIXES.some((prefix) => message.content.trim().startsWith(prefix));
