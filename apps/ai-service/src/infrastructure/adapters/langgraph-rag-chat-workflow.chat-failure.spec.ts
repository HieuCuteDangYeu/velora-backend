import { CreateNoContextAnswerUseCase } from '@ai/application/use-cases/create-no-context-answer.use-case';
import type { RagChatWorkflowState } from '@ai/domain/interfaces/rag-chat-workflow.interface';
import { LangGraphRagChatWorkflowAdapter } from './langgraph-rag-chat-workflow.adapter';

type FailureNode = (
  state: RagChatWorkflowState,
) => Promise<Partial<RagChatWorkflowState>>;

function failureNode(): FailureNode {
  const workflow = new LangGraphRagChatWorkflowAdapter(
    ...(Array(10).fill(undefined) as [
      never,
      never,
      never,
      never,
      never,
      never,
      never,
      never,
      never,
      never,
    ]),
    new CreateNoContextAnswerUseCase(),
    undefined as never,
    undefined as never,
    { get: jest.fn() } as never,
    undefined as never,
  ) as unknown as { createVerificationFailureNode: () => FailureNode };
  return workflow.createVerificationFailureNode();
}

const failedState = (intent: string) =>
  ({
    userId: 'user-1',
    conversationId: 'conversation-1',
    userMessage: 'hello',
    route: { intent, requiredEvidence: [] },
    rerankedChunks: [],
    retryCount: 1,
    retrievalRetryCount: 0,
    citationRetryCount: 0,
    citationAttempts: [],
    verification: {
      passed: false,
      confidence: 0,
      issues: ['unverified'],
      requiresRevision: false,
    },
  }) as unknown as RagChatWorkflowState;

describe('final fallback after verification fails', () => {
  it('does not claim to have context for an ordinary chat turn', async () => {
    const result = await failureNode()(failedState('NORMAL_CHAT'));
    expect(result.answer).toBe(
      'Sorry, I couldn’t put together an answer just now. Please try asking again.',
    );
    expect(result.citations).toEqual([]);
  });

  it('keeps the existing wording for reel questions and other intents', async () => {
    expect(
      (await failureNode()(failedState('REEL_VIDEO_QUESTION'))).answer,
    ).toBe(
      'I do not have enough verified shared reel evidence to answer that reliably.',
    );
    expect((await failureNode()(failedState('OFF_TOPIC'))).answer).toBe(
      'I could not verify that answer reliably from the available context.',
    );
  });

  it('says plainly when a remembered thing could not be found, instead of a generic verification failure', async () => {
    expect(
      (await failureNode()(failedState('CONVERSATION_MEMORY_QUESTION'))).answer,
    ).toBe('I could not find that in our conversation.');
    expect(
      (await failureNode()(failedState('USER_MEMORY_QUESTION'))).answer,
    ).toBe('I do not have that saved about you.');
  });

  it('quotes the confident match when verification rejects a recall answer', async () => {
    const state = {
      ...failedState('CONVERSATION_MEMORY_QUESTION'),
      recallQuote: {
        role: 'user',
        content: 'Mình hay mua cà phê ở quán Zorvak Cafe.',
        createdAt: '2026-11-19T00:00:00Z',
      },
    } as unknown as RagChatWorkflowState;

    expect((await failureNode()(state)).answer).toBe(
      'Earlier you wrote: “Mình hay mua cà phê ở quán Zorvak Cafe.”',
    );
  });
});
