import type { RagChatWorkflowState } from '@ai/domain/interfaces/rag-chat-workflow.interface';
import { ChatPromptBuilderAdapter } from './chat-prompt-builder.adapter';

describe('ChatPromptBuilderAdapter', () => {
  it('instructs factual reel drafts and revisions to use direct evidence wording', () => {
    const prompt = new ChatPromptBuilderAdapter().build({
      userId: 'user-1',
      conversationId: 'conversation-1',
      userMessage:
        'What safety measure do they say protects data if a building has a fire?',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        needsRetrieval: true,
        needsUserMemory: false,
        needsConversationSummary: false,
        needsVerification: true,
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        requiredEvidence: ['TRANSCRIPT'],
        recommendationAction: { type: 'NONE', reason: 'Shared reel question.' },
        reason: 'Transcript fact requested.',
      },
      memorySelection: {
        includeRecentHistory: false,
        includeConversationSummary: false,
        includeUserMemory: false,
        includeRetrievedChunks: true,
        reason: 'Retrieved reel evidence is required.',
      },
      retrievedChunks: [],
      rerankedChunks: [],
      retryCount: 0,
      retrievalRetryCount: 0,
      citationRetryCount: 0,
      citations: [],
      draftHistory: [],
      draftRevision: 0,
      citationAttempts: [],
      nextDraftSource: 'INITIAL',
      finalFailureSource: 'UNKNOWN',
    } satisfies RagChatWorkflowState);

    expect(prompt).toContain(
      'State that supported fact, not a plausible reformulation based only on the question.',
    );
    expect(prompt).toContain('Do not repeat an unsupported draft.');
  });

  it('keeps same-reel transcript continuation evidence ahead of unrelated results', () => {
    const prompt = new ChatPromptBuilderAdapter().build({
      userId: 'user-1',
      conversationId: 'conversation-1',
      userMessage:
        'What safety measure do they say protects data if a building has a fire?',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        needsRetrieval: true,
        needsUserMemory: false,
        needsConversationSummary: false,
        needsVerification: true,
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        requiredEvidence: ['TRANSCRIPT'],
        recommendationAction: { type: 'NONE', reason: 'Shared reel question.' },
        reason: 'Transcript fact requested.',
      },
      memorySelection: {
        includeRecentHistory: false,
        includeConversationSummary: false,
        includeUserMemory: false,
        includeRetrievedChunks: true,
        reason: 'Retrieved reel evidence is required.',
      },
      rerankedChunks: [
        {
          chunkId: 'chunk-1',
          reelId: 'in1002',
          distance: 0.1,
          evidenceType: 'TRANSCRIPT',
          evidenceText:
            'They have three backups in the university, but they will have backup at different.',
          chunkText:
            'They have three backups in the university, but they will have backup at different.',
          tags: [],
        },
        {
          chunkId: 'chunk-2',
          reelId: 'other-reel',
          distance: 0.2,
          evidenceType: 'TRANSCRIPT',
          evidenceText: 'Unrelated ranked result.',
          chunkText: 'Unrelated ranked result.',
          tags: [],
        },
        {
          chunkId: 'chunk-3',
          reelId: 'in1002',
          distance: 0.3,
          evidenceType: 'TRANSCRIPT',
          evidenceText:
            'They will have backup at different physical places and some underground, so it is fireproof.',
          chunkText:
            'They will have backup at different physical places and some underground, so it is fireproof.',
          tags: [],
        },
      ],
      retrievedChunks: [],
      retryCount: 0,
      retrievalRetryCount: 0,
      citationRetryCount: 0,
      citations: [],
      draftHistory: [],
      draftRevision: 0,
      citationAttempts: [],
      nextDraftSource: 'INITIAL',
      finalFailureSource: 'UNKNOWN',
    } satisfies RagChatWorkflowState);

    expect(prompt.indexOf('different physical places')).toBeGreaterThan(
      prompt.indexOf('three backups in the university'),
    );
    expect(prompt.indexOf('different physical places')).toBeLessThan(
      prompt.indexOf('Unrelated ranked result.'),
    );
  });

  it('bounds pathological history, summary, memories, and multimodal evidence', () => {
    const prompt = new ChatPromptBuilderAdapter().build({
      userId: 'user-1',
      conversationId: 'conversation-1',
      userMessage: 'What is discussed in the shared reel?',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        needsRetrieval: true,
        needsUserMemory: true,
        needsConversationSummary: true,
        needsVerification: true,
        reelQuestionType: 'GENERAL_REEL_SUMMARY',
        requiredEvidence: ['TRANSCRIPT', 'VISUAL', 'METADATA'],
        recommendationAction: { type: 'NONE', reason: 'Fixture.' },
        reason: 'Fixture route.',
      },
      memorySelection: {
        includeRecentHistory: true,
        includeConversationSummary: true,
        includeUserMemory: true,
        includeRetrievedChunks: true,
        reason: 'Fixture context.',
      },
      memory: {
        recentMessages: Array.from({ length: 12 }, (_, index) => ({
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: `history-${index} ${'long message '.repeat(500)}`,
          eventType: 'TEXT',
        })),
      },
      conversationMemory: { summary: 'summary '.repeat(1_000) },
      userMemories: {
        memories: Array.from({ length: 8 }, (_, index) => ({
          type: 'PREFERENCE',
          confidence: 0.9,
          content: `memory-${index} ${'long memory '.repeat(500)}`,
        })),
      },
      rerankedChunks: Array.from({ length: 8 }, (_, index) => ({
        chunkId: `chunk-${index}`,
        reelId: 'reel-1',
        evidenceType: index % 2 === 0 ? 'TRANSCRIPT' : 'VISUAL',
        evidenceText: `evidence-${index} ${'long evidence '.repeat(500)}`,
        chunkText: `evidence-${index} ${'long evidence '.repeat(500)}`,
        title: `title-${index} ${'long title '.repeat(100)}`,
        description: `description-${index} ${'long description '.repeat(100)}`,
        tags: ['fixture', 'multimodal'],
      })),
      retrievedChunks: [],
      retryCount: 0,
      retrievalRetryCount: 0,
      citationRetryCount: 0,
      citations: [],
      draftHistory: [],
      draftRevision: 0,
      citationAttempts: [],
      nextDraftSource: 'INITIAL',
      finalFailureSource: 'UNKNOWN',
    } satisfies RagChatWorkflowState);

    expect(prompt).toContain('history-11');
    expect(prompt).not.toContain('history-0');
    expect(prompt).toContain('memory-0');
    expect(prompt).not.toContain('memory-7');
    expect(prompt).toContain('evidence-0');
    expect(prompt).not.toContain('evidence-7');
    expect(prompt).not.toContain('summary '.repeat(900));
  });
});
