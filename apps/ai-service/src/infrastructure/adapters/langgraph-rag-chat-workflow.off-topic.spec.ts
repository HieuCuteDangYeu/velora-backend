import { CreateNoContextAnswerUseCase } from '@ai/application/use-cases/create-no-context-answer.use-case';
import type {
  RagChatRouteDecision,
  RagChatWorkflowState,
} from '@ai/domain/interfaces/rag-chat-workflow.interface';
import { LangGraphRagChatWorkflowAdapter } from './langgraph-rag-chat-workflow.adapter';

type Workflow = {
  searchReelsForPhotoTurn: (
    state: RagChatWorkflowState,
    route: RagChatRouteDecision,
  ) => RagChatRouteDecision;
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

  describe('photo turns the router called off topic', () => {
    const photoState = (userMessage: string) =>
      ({
        userMessage,
        images: [{ description: 'a lecture slide' }],
      }) as unknown as RagChatWorkflowState;

    it('become a reel search when the caption asks for reels or videos', () => {
      const route = workflow.searchReelsForPhotoTurn(
        photoState('find reels like this'),
        offTopic.route as RagChatRouteDecision,
      );

      expect(route.intent).toBe('NORMAL_CHAT');
      expect(route.recommendationAction.type).toBe('RECOMMEND_REELS');
      expect(
        workflow.routesAfterQueryRouter({
          ...photoState('find reels like this'),
          route,
        }),
      ).toEqual(['reelRecommendationNode']);
    });

    it('stay refused when the caption asks for something unrelated', () => {
      const route = workflow.searchReelsForPhotoTurn(
        photoState('solve this problem'),
        offTopic.route as RagChatRouteDecision,
      );

      expect(route.intent).toBe('OFF_TOPIC');
      expect(route.recommendationAction.type).toBe('NONE');
    });
  });
});
