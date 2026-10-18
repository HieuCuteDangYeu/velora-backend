import type {
  RagChatWorkflowState,
  RagGenerationEvidence,
} from '../interfaces/rag-chat-workflow.interface';
import {
  boundPromptText,
  boundRecentMessages,
  readRagPromptBounds,
  type RagPromptConfig,
} from './rag-prompt-bounds';

/** Scoped memory facts are internal grounding sources, never Reel citations. */
export function ragMemoryEvidence(
  state: RagChatWorkflowState,
  config: RagPromptConfig,
): RagGenerationEvidence[] {
  const intent = state.route?.intent;
  if (
    intent !== 'USER_MEMORY_QUESTION' &&
    intent !== 'CONVERSATION_MEMORY_QUESTION'
  )
    return [];
  const bounds = readRagPromptBounds(config);
  const evidence: RagGenerationEvidence[] = [];
  const add = (
    sourceId: string,
    evidenceType: 'USER_MEMORY' | 'CONVERSATION_MEMORY',
    text: string,
  ) => {
    if (text.trim())
      evidence.push({
        evidenceId: `m${evidence.length}`,
        sourceId,
        evidenceType,
        evidenceText: text,
      });
  };
  if (
    intent === 'CONVERSATION_MEMORY_QUESTION' &&
    state.conversationMemory?.conversationId === state.conversationId
  ) {
    add(
      `conversation-summary:${state.conversationId}`,
      'CONVERSATION_MEMORY',
      boundPromptText(
        state.conversationMemory.summary ?? '',
        bounds.maxSummaryChars,
      ),
    );
  }
  if (intent === 'USER_MEMORY_QUESTION') {
    let remaining = bounds.maxMemoryTotalChars;
    for (const [index, memory] of (state.userMemories?.memories ?? [])
      .filter((m) => m.userId === state.userId)
      .slice(0, bounds.maxMemories)
      .entries()) {
      const text = boundPromptText(
        memory.content,
        Math.min(remaining, bounds.maxMemoryItemChars),
      );
      remaining -= text.length;
      add(`user-memory:${memory.id ?? index}`, 'USER_MEMORY', text);
      if (remaining <= 0) break;
    }
  }
  for (const [index, message] of boundRecentMessages(
    state.memory?.recentMessages ?? [],
    bounds,
  ).entries()) {
    if (message.eventType === 'REEL_SHARE') continue;
    add(
      `conversation-message:${state.conversationId}:${index}`,
      'CONVERSATION_MEMORY',
      `${message.role}${message.createdAt ? ` at ${message.createdAt}` : ''}: ${message.content}`,
    );
  }
  return evidence;
}
