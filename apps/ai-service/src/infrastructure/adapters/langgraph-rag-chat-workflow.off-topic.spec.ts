import { CreateNoContextAnswerUseCase } from '@ai/application/use-cases/create-no-context-answer.use-case';
import type { RagChatWorkflowState } from '@ai/domain/interfaces/rag-chat-workflow.interface';
import { LangGraphRagChatWorkflowAdapter } from './langgraph-rag-chat-workflow.adapter';

type Workflow = {
  routesAfterQueryRouter: (state: RagChatWorkflowState) => string[];
  createNoContextAnswerNode: (
    nodeTimings: Record<string, number>,
  ) => (state: RagChatWorkflowState) => Promise<Partial<RagChatWorkflowState>>;
};

const workflow = new LangGraphRagChatWorkflowAdapter(
  undefined as never,
  undefined as never,
  undefined as never,
  undefined as never,
  undefined as never,
  undefined as never,
  undefined as never,
  undefined as never,
  undefined as never,
  undefined as never,
  new CreateNoContextAnswerUseCase(),
  undefined as never,
  undefined as never,
  { get: jest.fn() } as never,
  undefined as never,
) as unknown as Workflow;

const offTopic = {
  userMessage: 'What is the capital of France?',
  route: {
    intent: 'OFF_TOPIC',
    reelQuestionType: 'NONE',
    needsRetrieval: false,
    recommendationAction: { type: 'NONE' },
    toolPlan: { allowedTools: [], requiredTools: [] },
  },
} as unknown as RagChatWorkflowState;

describe('off-topic turns in the RAG workflow', () => {
  it('go straight to the fixed redirect, with no memory, tools or retrieval', () => {
    expect(workflow.routesAfterQueryRouter(offTopic)).toEqual([
      'noContextAnswerNode',
    ]);
  });

  it('are answered with the redirect and are not counted as a failure', async () => {
    const result = await workflow.createNoContextAnswerNode({})(offTopic);

    expect(result.answer).toMatch(/only help with Velora/i);
    expect(result.citations).toEqual([]);
    expect(result.finalFailureSource).toBe('NONE');
  });

  it('still reports a real no-context answer as NO_CONTEXT', async () => {
    const result = await workflow.createNoContextAnswerNode({})({
      userMessage: 'Which clip?',
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        reelQuestionType: 'AMBIGUOUS_REEL_REFERENCE',
      },
    } as unknown as RagChatWorkflowState);

    expect(result.finalFailureSource).toBe('NO_CONTEXT');
  });
});
