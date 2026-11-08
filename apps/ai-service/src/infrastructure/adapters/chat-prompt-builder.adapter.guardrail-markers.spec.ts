import { SYSTEM_PROMPT_MARKERS } from '@ai/domain/services/rag-guardrail/rag-output-guardrail';
import { ChatPromptBuilderAdapter } from './chat-prompt-builder.adapter';

/**
 * The output guardrail detects system-prompt leaks by these headings. If the
 * prompt builder is reworded, this fails instead of silently disabling the check.
 */
describe('system prompt markers used by the output guardrail', () => {
  it('all still appear in the prompt the builder produces', () => {
    const prompt = new ChatPromptBuilderAdapter()
      .build({
        userMessage: 'hi',
        userId: 'u',
        conversationId: 'c',
        accessibleReelIds: [],
        hasSharedReelContext: false,
        retrievedChunks: [],
        rerankedChunks: [],
        retrievalReady: false,
        recommendedReels: [],
        suggestedQueries: [],
        memoryReady: false,
        answerDiagnostics: [],
        citations: [],
        retryCount: 0,
        retrievalRetryCount: 0,
        citationRetryCount: 0,
        draftHistory: [],
        draftRevision: 0,
        citationAttempts: [],
        nextDraftSource: 'INITIAL',
        finalFailureSource: 'UNKNOWN',
      } as never)
      .toLowerCase();
    for (const marker of SYSTEM_PROMPT_MARKERS) {
      expect(prompt).toContain(marker);
    }
  });
});
