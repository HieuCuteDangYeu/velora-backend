import { BuildRagCitationsUseCase } from '@ai/application/use-cases/build-rag-citations.use-case';
import { BuildGroundedAnswerRevisionUseCase } from '@ai/application/use-cases/build-grounded-answer-revision.use-case';
import { CheckContextSufficiencyUseCase } from '@ai/application/use-cases/check-context-sufficiency.use-case';
import { CreateNoContextAnswerUseCase } from '@ai/application/use-cases/create-no-context-answer.use-case';
import { GenerateDraftAnswerUseCase } from '@ai/application/use-cases/generate-draft-answer.use-case';
import { MemoryAgentUseCase } from '@ai/application/use-cases/memory-agent.use-case';
import { PlanRetrievalUseCase } from '@ai/application/use-cases/plan-retrieval.use-case';
import { QueryRouterAgentUseCase } from '@ai/application/use-cases/query-router-agent.use-case';
import { RerankRetrievedEvidenceUseCase } from '@ai/application/use-cases/rerank-retrieved-evidence.use-case';
import { RetrieveReelEvidenceUseCase } from '@ai/application/use-cases/retrieve-reel-evidence.use-case';
import { RewriteRetrievalQueryUseCase } from '@ai/application/use-cases/rewrite-retrieval-query.use-case';
import { SaveRagTraceUseCase } from '@ai/application/use-cases/save-rag-trace.use-case';
import { StreamFinalAnswerUseCase } from '@ai/application/use-cases/stream-final-answer.use-case';
import { VerifierAgentUseCase } from '@ai/application/use-cases/verifier-agent.use-case';
import type {
  IContentService,
  TranscriptMatch,
} from '@ai/domain/interfaces/content-service.interface';
import type {
  IRagChatWorkflow,
  RagChatWorkflowInput,
  RagChatWorkflowResult,
  RagChatWorkflowState,
  RagChatRouteDecision,
  RagRequiredEvidence,
  RagRouterSemanticInconsistencyDetails,
  RagRouterSemanticInconsistencyType,
  RagStructuredCallFailureDiagnostic,
  RagRetrievalExecutionDiagnostics,
  RagRetrievalPlan,
} from '@ai/domain/interfaces/rag-chat-workflow.interface';
import { END, START, StateGraph, StateSchema } from '@langchain/langgraph';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod/v4';
import {
  boundRecentMessages,
  boundPromptText,
  readRagPromptBounds,
} from '@ai/domain/services/rag-prompt-bounds';

const RagChatStateSchema = new StateSchema({
  userId: z.string(),
  conversationId: z.string(),
  userMessage: z.string(),
  memory: z.any().optional(),
  accessibleReelIds: z.array(z.string()).default([]),
  hasSharedReelContext: z.boolean().default(false),

  route: z.any().optional(),
  retrievalPlan: z.any().optional(),
  retrievalRepairQuery: z.string().optional(),

  retrievedChunks: z.array(z.any()).default([]),
  rerankedChunks: z.array(z.any()).default([]),
  retrievalExecution: z.any().optional(),
  retrievalReady: z.boolean().default(false),

  recommendedReels: z.array(z.any()).default([]),
  suggestedQueries: z.array(z.string()).default([]),

  contextSufficiency: z.any().optional(),

  conversationMemory: z.any().optional(),
  userMemories: z.any().optional(),
  memorySelection: z.any().optional(),
  memoryReady: z.boolean().default(false),

  answer: z.string().optional(),
  answerDiagnostics: z.array(z.any()).default([]),
  verification: z.any().optional(),
  citations: z.array(z.any()).default([]),
  citationCoverage: z.any().optional(),
  groundedRevision: z.any().optional(),
  draftHistory: z.array(z.any()).default([]),
  draftRevision: z.number().default(0),
  citationAttempts: z.array(z.any()).default([]),
  nextDraftSource: z.any().default('INITIAL'),
  finalFailureSource: z.any().default('UNKNOWN'),
  failureDiagnostics: z.any().optional(),

  retryCount: z.number().default(0),
  retrievalRetryCount: z.number().default(0),
  citationRetryCount: z.number().default(0),
});

@Injectable()
export class LangGraphRagChatWorkflowAdapter implements IRagChatWorkflow {
  private readonly logger = new Logger(LangGraphRagChatWorkflowAdapter.name);
  private readonly executionContexts = new WeakMap<
    Record<string, number>,
    {
      failedNode?: string;
      route?: RagChatRouteDecision;
      retrievalPlan?: RagRetrievalPlan;
      retrievalExecution?: RagRetrievalExecutionDiagnostics;
    }
  >();

  constructor(
    private readonly queryRouterAgentUseCase: QueryRouterAgentUseCase,
    private readonly planRetrievalUseCase: PlanRetrievalUseCase,
    private readonly retrieveReelEvidenceUseCase: RetrieveReelEvidenceUseCase,
    private readonly rerankRetrievedEvidenceUseCase: RerankRetrievedEvidenceUseCase,
    private readonly rewriteRetrievalQueryUseCase: RewriteRetrievalQueryUseCase,
    private readonly checkContextSufficiencyUseCase: CheckContextSufficiencyUseCase,
    private readonly memoryAgentUseCase: MemoryAgentUseCase,
    private readonly generateDraftAnswerUseCase: GenerateDraftAnswerUseCase,
    private readonly verifierAgentUseCase: VerifierAgentUseCase,
    private readonly streamFinalAnswerUseCase: StreamFinalAnswerUseCase,
    private readonly createNoContextAnswerUseCase: CreateNoContextAnswerUseCase,
    private readonly buildRagCitationsUseCase: BuildRagCitationsUseCase,
    private readonly saveRagTraceUseCase: SaveRagTraceUseCase,
    private readonly config: ConfigService,

    @Inject('IContentService')
    private readonly contentService: IContentService,
    private readonly buildGroundedAnswerRevisionUseCase?: BuildGroundedAnswerRevisionUseCase,
  ) {}

  async execute(input: RagChatWorkflowInput): Promise<RagChatWorkflowResult> {
    const nodeTimings: Record<string, number> = {};
    const executionContext: {
      failedNode?: string;
      route?: RagChatRouteDecision;
      retrievalPlan?: RagRetrievalPlan;
      retrievalExecution?: RagRetrievalExecutionDiagnostics;
    } = {};
    this.executionContexts.set(nodeTimings, executionContext);
    const graph = this.buildGraph(nodeTimings);
    const startedAt = Date.now();

    const initialState: RagChatWorkflowState = {
      userId: input.userId,
      conversationId: input.conversationId,
      userMessage: input.message,
      memory: input.memory,
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
    };

    let result: RagChatWorkflowState = initialState;

    try {
      result = await graph.invoke(initialState, { recursionLimit: 64 });

      return {
        answer: result.answer?.trim() ?? '',
        citations: result.citations ?? [],
        recommendedReels: result.recommendedReels ?? [],
        suggestedQueries: result.suggestedQueries ?? [],
      };
    } catch (error: unknown) {
      const retrievalExecution = executionContext.retrievalExecution;
      const route = executionContext.route;
      const retrievalPlan = executionContext.retrievalPlan;
      result = {
        ...result,
        ...(route ? { route } : {}),
        ...(retrievalPlan ? { retrievalPlan } : {}),
        ...(retrievalExecution ? { retrievalExecution } : {}),
        finalFailureSource: this.failureSource(error),
        failureDiagnostics: this.buildFailureDiagnostics(
          error,
          executionContext.failedNode,
        ),
      };
      throw error;
    } finally {
      this.executionContexts.delete(nodeTimings);
      await this.saveRagTraceUseCase.execute({
        state: result,
        latencyMs: Date.now() - startedAt,
        nodeTimings,
      });
    }
  }

  private buildGraph(nodeTimings: Record<string, number>) {
    return new StateGraph(RagChatStateSchema)
      .addNode(
        'resolveReelContextNode',
        this.createResolveReelContextNode(nodeTimings),
      )
      .addNode('queryRouterNode', this.createQueryRouterNode(nodeTimings))
      .addNode(
        'retrievalPlannerNode',
        this.createRetrievalPlannerNode(nodeTimings),
      )
      .addNode('retrievalNode', this.createRetrievalNode(nodeTimings))
      .addNode('neuralRerankerNode', this.createNeuralRerankerNode(nodeTimings))
      .addNode(
        'contextSufficiencyNode',
        this.createContextSufficiencyNode(nodeTimings),
      )
      .addNode(
        'retrievalRepairNode',
        this.createRetrievalRepairNode(nodeTimings),
      )
      .addNode('markRetrievalReadyNode', () => ({ retrievalReady: true }))
      .addNode('memorySelectorNode', this.createMemoryNode(nodeTimings))
      .addNode('answerContextJoinNode', () => ({}))
      .addNode('draftAnswerNode', this.createDraftAnswerNode(nodeTimings))
      .addNode('verifierNode', this.createVerifierNode(nodeTimings))
      .addNode(
        'prepareAnswerRevisionNode',
        this.createPrepareAnswerRevisionNode(),
      )
      .addNode('citationNode', this.createCitationNode(nodeTimings))
      .addNode(
        'citationCoverageGateNode',
        this.createCitationCoverageGateNode(nodeTimings),
      )
      .addNode(
        'prepareCitationRevisionNode',
        this.createPrepareCitationRevisionNode(),
      )
      .addNode('verificationFailureNode', this.createVerificationFailureNode())
      .addNode(
        'noContextAnswerNode',
        this.createNoContextAnswerNode(nodeTimings),
      )
      .addNode('finalAnswerNode', this.createFinalAnswerNode(nodeTimings))
      .addNode(
        'reelRecommendationNode',
        this.createReelRecommendationNode(nodeTimings),
      )

      .addEdge(START, 'resolveReelContextNode')
      .addEdge('resolveReelContextNode', 'queryRouterNode')
      .addConditionalEdges('queryRouterNode', this.routesAfterQueryRouter, [
        'retrievalPlannerNode',
        'memorySelectorNode',
        'reelRecommendationNode',
      ])
      .addEdge('retrievalPlannerNode', 'retrievalNode')
      .addEdge('retrievalNode', 'neuralRerankerNode')
      .addEdge('neuralRerankerNode', 'contextSufficiencyNode')
      .addConditionalEdges(
        'contextSufficiencyNode',
        this.routeAfterContextSufficiency,
        [
          'markRetrievalReadyNode',
          'retrievalRepairNode',
          'noContextAnswerNode',
        ],
      )
      .addEdge('retrievalRepairNode', 'retrievalPlannerNode')
      .addEdge('markRetrievalReadyNode', 'answerContextJoinNode')
      .addEdge('memorySelectorNode', 'answerContextJoinNode')
      .addConditionalEdges(
        'answerContextJoinNode',
        this.routeAfterContextJoin,
        ['draftAnswerNode', END],
      )
      .addEdge('draftAnswerNode', 'verifierNode')
      .addConditionalEdges('verifierNode', this.routeAfterVerifier, [
        'citationNode',
        'prepareAnswerRevisionNode',
        'verificationFailureNode',
      ])
      .addEdge('prepareAnswerRevisionNode', 'draftAnswerNode')
      .addEdge('citationNode', 'citationCoverageGateNode')
      .addConditionalEdges(
        'citationCoverageGateNode',
        this.routeAfterCitationCoverage,
        [
          'finalAnswerNode',
          'prepareCitationRevisionNode',
          'verificationFailureNode',
        ],
      )
      .addEdge('prepareCitationRevisionNode', 'draftAnswerNode')
      .addEdge('verificationFailureNode', 'finalAnswerNode')
      .addEdge('noContextAnswerNode', 'finalAnswerNode')
      .addEdge('finalAnswerNode', END)
      .addEdge('reelRecommendationNode', END)
      .compile();
  }

  private createQueryRouterNode(nodeTimings: Record<string, number>) {
    return async (
      state: RagChatWorkflowState,
    ): Promise<Partial<RagChatWorkflowState>> => {
      const route = await this.timed('queryRouterNode', nodeTimings, () =>
        this.queryRouterAgentUseCase.execute({
          message: state.userMessage,
          recentHistory: this.formatRecentHistory(state),
          hasSharedReelContext: state.hasSharedReelContext,
          sharedReelCount: state.accessibleReelIds?.length ?? 0,
          referentContext: this.buildRouterReferentContext(state),
        }),
      );

      this.logger.debug(
        `[RagGraph] route intent=${route.intent} retrieval=${route.needsRetrieval} recommendation=${route.recommendationAction.type}`,
      );
      const executionContext = this.executionContexts.get(nodeTimings);
      if (executionContext) executionContext.route = route;

      return { route };
    };
  }

  private createResolveReelContextNode(nodeTimings: Record<string, number>) {
    return async (
      state: RagChatWorkflowState,
    ): Promise<Partial<RagChatWorkflowState>> => {
      const accessibleReelIds = await this.timed(
        'resolveReelContextNode',
        nodeTimings,
        () =>
          this.contentService.resolveReelContextAccess({
            userId: state.userId,
            conversationId: state.conversationId,
          }),
      );

      return {
        accessibleReelIds,
        hasSharedReelContext: accessibleReelIds.length > 0,
      };
    };
  }

  private createRetrievalPlannerNode(nodeTimings: Record<string, number>) {
    return async (
      state: RagChatWorkflowState,
    ): Promise<Partial<RagChatWorkflowState>> => {
      if (!state.route) return {};
      const planningMessage =
        state.retrievalRepairQuery?.trim() || state.userMessage;
      const retrievalPlan = await this.timed(
        'retrievalPlannerNode',
        nodeTimings,
        () =>
          this.planRetrievalUseCase.execute({
            message: planningMessage,
            route: state.route!,
          }),
      );

      this.logger.debug(
        `[RagGraph] retrieval plan mode=${retrievalPlan.mode} queries=${retrievalPlan.queries?.length ?? 0} searchLimit=${retrievalPlan.searchLimit} rerankLimit=${retrievalPlan.rerankLimit}`,
      );
      const executionContext = this.executionContexts.get(nodeTimings);
      if (executionContext) executionContext.retrievalPlan = retrievalPlan;
      return { retrievalPlan };
    };
  }

  private createRetrievalNode(nodeTimings: Record<string, number>) {
    return async (
      state: RagChatWorkflowState,
    ): Promise<Partial<RagChatWorkflowState>> => {
      if (!state.route || !state.retrievalPlan) return {};

      const retrievalExecution =
        state.retrievalExecution ??
        this.createRetrievalExecutionDiagnostics(state.accessibleReelIds);
      let retrievedChunks: TranscriptMatch[];
      try {
        retrievedChunks = await this.timed('retrievalNode', nodeTimings, () =>
          this.retrieveReelEvidenceUseCase.execute({
            userId: state.userId,
            conversationId: state.conversationId,
            route: state.route!,
            plan: state.retrievalPlan!,
            accessibleReelIds: state.accessibleReelIds,
            diagnostics: retrievalExecution,
          }),
        );
      } catch (error: unknown) {
        const executionContext = this.executionContexts.get(nodeTimings);
        if (executionContext) {
          executionContext.retrievalExecution = retrievalExecution;
        }
        throw error;
      }

      this.logger.log(
        `[RagGraph] retrieved=${retrievedChunks.length} retry=${state.retrievalRetryCount}`,
      );
      const executionContext = this.executionContexts.get(nodeTimings);
      if (executionContext) {
        executionContext.retrievalExecution = retrievalExecution;
      }

      return {
        retrievedChunks,
        rerankedChunks: [],
        retrievalExecution,
      };
    };
  }

  private createNeuralRerankerNode(nodeTimings: Record<string, number>) {
    return async (
      state: RagChatWorkflowState,
    ): Promise<Partial<RagChatWorkflowState>> => {
      if (!state.retrievalPlan) return { rerankedChunks: [] };

      const retrievalExecution =
        state.retrievalExecution ??
        this.createRetrievalExecutionDiagnostics(state.accessibleReelIds);
      let rerankedChunks: TranscriptMatch[];
      try {
        rerankedChunks = await this.timed(
          'neuralRerankerNode',
          nodeTimings,
          () =>
            this.rerankRetrievedEvidenceUseCase.execute({
              plan: state.retrievalPlan!,
              retrievedChunks: state.retrievedChunks,
              diagnostics: retrievalExecution,
            }),
        );
      } catch (error: unknown) {
        const executionContext = this.executionContexts.get(nodeTimings);
        if (executionContext) {
          executionContext.retrievalExecution = retrievalExecution;
        }
        throw error;
      }

      this.logger.log(`[RagGraph] reranked=${rerankedChunks.length}`);
      const executionContext = this.executionContexts.get(nodeTimings);
      if (executionContext) {
        executionContext.retrievalExecution = retrievalExecution;
      }
      return { rerankedChunks, retrievalExecution };
    };
  }

  private createContextSufficiencyNode(nodeTimings: Record<string, number>) {
    return async (
      state: RagChatWorkflowState,
    ): Promise<Partial<RagChatWorkflowState>> => {
      const contextSufficiency = await this.timed(
        'contextSufficiencyNode',
        nodeTimings,
        () => this.checkContextSufficiencyUseCase.execute(state),
      );

      this.logger.debug(
        `[RagGraph] context sufficient=${contextSufficiency.sufficient} action=${contextSufficiency.recommendedAction}`,
      );

      return { contextSufficiency };
    };
  }

  private createRetrievalRepairNode(nodeTimings: Record<string, number>) {
    return async (
      state: RagChatWorkflowState,
    ): Promise<Partial<RagChatWorkflowState>> => {
      const query = await this.timed('retrievalRepairNode', nodeTimings, () =>
        this.rewriteRetrievalQueryUseCase.execute(state),
      );

      this.logger.debug(
        `[RagGraph] retrieval repair retry=${state.retrievalRetryCount + 1} query=${JSON.stringify(query)}`,
      );

      return {
        retrievalRepairQuery: query,
        retrievalPlan: undefined,
        retrievalRetryCount: state.retrievalRetryCount + 1,
        retrievalReady: false,
        retrievedChunks: [],
        rerankedChunks: [],
      };
    };
  }

  private createMemoryNode(nodeTimings: Record<string, number>) {
    return async (
      state: RagChatWorkflowState,
    ): Promise<Partial<RagChatWorkflowState>> => {
      const route = state.route;

      if (!route) {
        return { memoryReady: true };
      }

      const result = await this.timed('memorySelectorNode', nodeTimings, () =>
        this.memoryAgentUseCase.execute({
          userId: state.userId,
          conversationId: state.conversationId,
          message: boundPromptText(
            state.userMessage,
            readRagPromptBounds(this.config).maxUserMessageChars,
          ),
          route,
          memory: state.memory,
        }),
      );

      return {
        memorySelection: result.selection,
        conversationMemory: result.conversationMemory,
        userMemories: result.userMemories,
        memoryReady: true,
      };
    };
  }

  private createDraftAnswerNode(nodeTimings: Record<string, number>) {
    return async (
      state: RagChatWorkflowState,
    ): Promise<Partial<RagChatWorkflowState>> => {
      const groundedRevisionUseCase = this.buildGroundedAnswerRevisionUseCase;
      const groundedRevision = groundedRevisionUseCase
        ? await groundedRevisionUseCase.executeWithProvenance(state)
        : undefined;
      const groundedAnswer = groundedRevision?.answer;
      const draft = groundedAnswer
        ? undefined
        : await this.timed('draftAnswerNode', nodeTimings, () =>
            this.generateDraftAnswerUseCase.execute(state),
          );
      const answer = groundedAnswer ?? draft!.answer;

      return {
        answer,
        answerClaims: groundedRevision
          ? [
              {
                claim: groundedRevision.answer,
                evidenceIds: groundedRevision.evidenceIds,
              },
            ]
          : draft!.claims,
        answerDiagnostics: draft?.diagnostics,
        citations: [],
        citationCoverage: undefined,
        groundedRevision: groundedRevision
          ? {
              evidenceIds: groundedRevision.evidenceIds,
              modelRole: groundedRevision.modelRole,
            }
          : undefined,
        draftHistory: [
          ...state.draftHistory,
          {
            revision: state.draftRevision,
            source: groundedAnswer
              ? 'GROUNDED_VERIFIER_REVISION'
              : state.nextDraftSource,
            answer: answer.slice(0, 1500),
          },
        ].slice(-this.integer('AI_RAG_MAX_ANSWER_REVISIONS', 1, 0, 2) - 1),
        draftRevision: state.draftRevision + 1,
      };
    };
  }

  private createVerifierNode(nodeTimings: Record<string, number>) {
    return async (
      state: RagChatWorkflowState,
    ): Promise<Partial<RagChatWorkflowState>> => {
      const verification = await this.timed('verifierNode', nodeTimings, () =>
        this.verifierAgentUseCase.execute(state),
      );

      this.logger.debug(
        `[RagGraph] verification passed=${verification.passed} confidence=${verification.confidence.toFixed(2)} revision=${verification.requiresRevision}`,
      );

      return { verification };
    };
  }

  private createPrepareAnswerRevisionNode() {
    return (state: RagChatWorkflowState): Partial<RagChatWorkflowState> => ({
      retryCount: state.retryCount + 1,
      nextDraftSource: 'VERIFIER_REVISION',
      citations: [],
      citationCoverage: undefined,
      citationDiagnostics: undefined,
    });
  }

  private createCitationNode(nodeTimings: Record<string, number>) {
    return async (
      state: RagChatWorkflowState,
    ): Promise<Partial<RagChatWorkflowState>> => {
      const assessment = await this.timed('citationNode', nodeTimings, () =>
        this.buildRagCitationsUseCase.execute(state),
      );

      return {
        citations: assessment.citations,
        citationCoverage: assessment.coverage,
        citationDiagnostics: assessment.coverage.diagnostics,
        citationAttempts: [
          ...state.citationAttempts,
          {
            attempt: state.citationAttempts.length,
            decisionSource:
              assessment.coverage.diagnostics?.decisionSource ??
              assessment.coverage.mode,
            coverage: assessment.coverage.coverage,
            selectedEvidenceIds:
              assessment.coverage.diagnostics?.selectedEvidenceIds ?? [],
            deterministicSupportingEvidenceIds:
              assessment.coverage.diagnostics
                ?.deterministicSupportingEvidenceIds ?? [],
            selectedEvidenceMappings:
              assessment.coverage.diagnostics?.selectedEvidenceMappings ?? [],
            providerStatus: assessment.coverage.diagnostics?.providerStatus,
            model: assessment.coverage.diagnostics?.model,
            semanticCalls: assessment.coverage.diagnostics?.semanticCalls ?? [],
            errorCode: assessment.coverage.diagnostics?.errorCode,
            providerCategory: assessment.coverage.diagnostics?.providerCategory,
          },
        ].slice(-this.integer('AI_RAG_MAX_CITATION_REVISIONS', 1, 0, 2) - 1),
      };
    };
  }

  private createCitationCoverageGateNode(nodeTimings: Record<string, number>) {
    return async (
      state: RagChatWorkflowState,
    ): Promise<Partial<RagChatWorkflowState>> => {
      await this.timed('citationCoverageGateNode', nodeTimings, () => {
        const coverage = state.citationCoverage;
        this.logger.debug(
          `[RagGraph] citation coverage mode=${coverage?.mode ?? 'NONE'} coverage=${coverage?.coverage ?? 1} claims=${coverage?.supportedClaimCount ?? 0}/${coverage?.factualClaimCount ?? 0}`,
        );
        return Promise.resolve();
      });
      return {};
    };
  }

  private createPrepareCitationRevisionNode() {
    return (state: RagChatWorkflowState): Partial<RagChatWorkflowState> => {
      const unsupported = state.citationCoverage?.unsupportedClaims ?? [];
      const detail = unsupported.length
        ? ` Unsupported claims: ${unsupported.join(' | ')}`
        : '';

      return {
        citationRetryCount: state.citationRetryCount + 1,
        nextDraftSource: 'CITATION_REVISION',
        citations: [],
        citationCoverage: undefined,
        verification: {
          passed: false,
          confidence: state.citationCoverage?.coverage ?? 0,
          issues: ['Citation coverage is below the production threshold.'],
          requiresRevision: true,
          revisedInstruction: `Remove, qualify, or rewrite factual reel claims that are not directly supported by the supplied grounded evidence. Do not add new facts.${detail}`,
        },
      };
    };
  }

  private createVerificationFailureNode() {
    return (state: RagChatWorkflowState): Partial<RagChatWorkflowState> => ({
      answer:
        state.route?.intent === 'REEL_VIDEO_QUESTION'
          ? 'I do not have enough verified shared reel evidence to answer that reliably.'
          : 'I could not verify that answer reliably from the available context.',
      citations: [],
      citationCoverage: {
        mode: 'NOT_REQUIRED',
        coverage: 1,
        factualClaimCount: 0,
        supportedClaimCount: 0,
        unsupportedClaims: [],
      },
      finalFailureSource: state.citationCoverage ? 'CITATION' : 'VERIFIER',
    });
  }

  private createFinalAnswerNode(nodeTimings: Record<string, number>) {
    return async (
      state: RagChatWorkflowState,
    ): Promise<Partial<RagChatWorkflowState>> => {
      const answer = await this.timed('finalAnswerNode', nodeTimings, () =>
        this.streamFinalAnswerUseCase.execute(state),
      );

      return {
        answer,
        finalFailureSource:
          state.finalFailureSource === 'UNKNOWN'
            ? 'NONE'
            : state.finalFailureSource,
      };
    };
  }

  private createNoContextAnswerNode(nodeTimings: Record<string, number>) {
    return async (
      state: RagChatWorkflowState,
    ): Promise<Partial<RagChatWorkflowState>> => {
      const answer = await this.timed('noContextAnswerNode', nodeTimings, () =>
        Promise.resolve(this.createNoContextAnswerUseCase.execute(state)),
      );

      return {
        answer,
        citations: [],
        citationCoverage: {
          mode: 'NOT_REQUIRED',
          coverage: 1,
          factualClaimCount: 0,
          supportedClaimCount: 0,
          unsupportedClaims: [],
        },
        finalFailureSource: 'NO_CONTEXT',
      };
    };
  }

  private createRetrievalExecutionDiagnostics(
    accessibleReelIds?: string[],
  ): RagRetrievalExecutionDiagnostics {
    return {
      accessibleReelCount: accessibleReelIds?.length ?? 0,
      accessibleReelIds: accessibleReelIds?.slice(0, 32) ?? [],
      accessibleReelIdsTruncated: (accessibleReelIds?.length ?? 0) > 32,
      queryCount: 0,
      queries: [],
      retrievedCount: 0,
      rerankedCount: 0,
    };
  }

  private createReelRecommendationNode(nodeTimings: Record<string, number>) {
    return async (
      state: RagChatWorkflowState,
    ): Promise<Partial<RagChatWorkflowState>> => {
      const action = state.route?.recommendationAction;

      if (!action || action.type === 'NONE') {
        return {
          recommendedReels: [],
          suggestedQueries: [],
        };
      }

      if (action.type === 'SUGGEST_QUERIES') {
        return {
          recommendedReels: [],
          suggestedQueries: action.suggestedQueries ?? [],
        };
      }

      const query = action.query?.trim() || state.userMessage.trim();

      try {
        const recommendedReels = await this.timed(
          'reelRecommendationNode',
          nodeTimings,
          async () => {
            const searchResults = query
              ? await this.contentService.searchPublicReels({
                  query,
                  viewerId: state.userId,
                  limit: 8,
                })
              : [];

            const uniqueSearchResults =
              this.dedupeRecommendedReels(searchResults);

            if (
              uniqueSearchResults.length >= action.minRelevantItems ||
              !action.allowPersonalizedFallback
            ) {
              return uniqueSearchResults.slice(0, 8);
            }

            const fallback = await this.contentService.getRecommendedReels({
              viewerId: state.userId,
              limit: 8,
            });

            return this.dedupeRecommendedReels([
              ...uniqueSearchResults,
              ...fallback,
            ]).slice(0, 8);
          },
        );

        return {
          recommendedReels,
          suggestedQueries: [],
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `[RagGraph] recommendation branch failed open: ${message}`,
        );
        return { recommendedReels: [], suggestedQueries: [] };
      }
    };
  }

  private dedupeRecommendedReels(
    reels: NonNullable<RagChatWorkflowState['recommendedReels']>,
  ): NonNullable<RagChatWorkflowState['recommendedReels']> {
    const map = new Map<string, (typeof reels)[number]>();

    for (const reel of reels) {
      if (!reel?.id || map.has(reel.id)) {
        continue;
      }

      map.set(reel.id, reel);
    }

    return [...map.values()];
  }

  private routesAfterQueryRouter = (
    state: RagChatWorkflowState,
  ): Array<
    'retrievalPlannerNode' | 'memorySelectorNode' | 'reelRecommendationNode'
  > => {
    const destinations: Array<
      'retrievalPlannerNode' | 'memorySelectorNode' | 'reelRecommendationNode'
    > = ['memorySelectorNode'];

    if (state.route?.needsRetrieval) {
      destinations.push('retrievalPlannerNode');
    }
    if (state.route?.recommendationAction.type !== 'NONE') {
      destinations.push('reelRecommendationNode');
    }

    return destinations;
  };

  private routeAfterContextSufficiency = (
    state: RagChatWorkflowState,
  ):
    | 'markRetrievalReadyNode'
    | 'retrievalRepairNode'
    | 'noContextAnswerNode' => {
    const context = state.contextSufficiency;
    if (!context) return 'markRetrievalReadyNode';

    if (context.sufficient && context.recommendedAction === 'ANSWER') {
      return 'markRetrievalReadyNode';
    }

    if (
      context.recommendedAction === 'REWRITE_AND_RETRY' &&
      state.retrievalRetryCount <
        this.integer('AI_RAG_MAX_RETRIEVAL_RETRIES', 1, 0, 2)
    ) {
      return 'retrievalRepairNode';
    }

    return 'noContextAnswerNode';
  };

  private routeAfterContextJoin = (
    state: RagChatWorkflowState,
  ): 'draftAnswerNode' | typeof END => {
    const memoryReady = state.memoryReady === true;
    const retrievalReady =
      !state.route?.needsRetrieval || state.retrievalReady === true;
    return memoryReady && retrievalReady ? 'draftAnswerNode' : END;
  };

  private routeAfterVerifier = (
    state: RagChatWorkflowState,
  ):
    | 'citationNode'
    | 'prepareAnswerRevisionNode'
    | 'verificationFailureNode' => {
    const minimumConfidence = this.number(
      'AI_RAG_VERIFIER_MIN_CONFIDENCE',
      0.65,
      0,
      1,
    );
    if (
      state.verification?.passed &&
      state.verification.confidence >= minimumConfidence
    ) {
      return 'citationNode';
    }

    if (
      state.verification?.requiresRevision &&
      state.retryCount < this.integer('AI_RAG_MAX_ANSWER_REVISIONS', 1, 0, 2)
    ) {
      return 'prepareAnswerRevisionNode';
    }

    return 'verificationFailureNode';
  };

  private routeAfterCitationCoverage = (
    state: RagChatWorkflowState,
  ):
    | 'finalAnswerNode'
    | 'prepareCitationRevisionNode'
    | 'verificationFailureNode' => {
    const coverage = state.citationCoverage;
    if (!coverage || coverage.mode === 'NOT_REQUIRED') {
      return 'finalAnswerNode';
    }

    if (coverage.mode === 'LLM' && coverage.factualClaimCount === 0)
      return 'finalAnswerNode';

    const threshold = this.number(
      'AI_RAG_CITATION_COVERAGE_THRESHOLD',
      1,
      0,
      1,
    );
    if (coverage.coverage >= threshold) return 'finalAnswerNode';

    if (
      state.citationRetryCount <
      this.integer('AI_RAG_MAX_CITATION_REVISIONS', 1, 0, 2)
    ) {
      return 'prepareCitationRevisionNode';
    }

    return 'verificationFailureNode';
  };

  private async timed<T>(
    label: string,
    nodeTimings: Record<string, number>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    const executionContext = this.executionContexts.get(nodeTimings);
    let completed = false;

    try {
      const result = await fn();
      completed = true;
      return result;
    } finally {
      const duration = Date.now() - startedAt;
      nodeTimings[label] = (nodeTimings[label] ?? 0) + duration;
      if (!completed && executionContext) {
        executionContext.failedNode = label;
      }

      this.logger.debug(`[RagGraphTiming] ${label}=${duration}ms`);
    }
  }

  private failureSource(
    error: unknown,
  ): RagChatWorkflowState['finalFailureSource'] {
    const errorCode = this.errorString(error, 'code');
    return errorCode === 'ROUTER_UNAVAILABLE' ||
      errorCode?.startsWith('STRUCTURED_COMPLETION_')
      ? 'PROVIDER_ERROR'
      : 'WORKFLOW';
  }

  private buildFailureDiagnostics(
    error: unknown,
    failedNode?: string,
  ): NonNullable<RagChatWorkflowState['failureDiagnostics']> {
    const record = this.errorRecord(error);
    const errorCode = this.errorString(error, 'code');
    const causeCode = this.errorString(error, 'causeCode');
    const semanticInconsistencyType = this.semanticInconsistencyType(
      record.semanticInconsistencyType,
    );
    const semanticInconsistencyDetails = this.safeSemanticInconsistencyDetails(
      record.semanticInconsistencyDetails,
    );
    const semanticCalls = Array.isArray(record.semanticCalls)
      ? record.semanticCalls
          .map((call) => this.toPersistedStructuredDiagnostic(call))
          .filter(
            (call): call is RagStructuredCallFailureDiagnostic =>
              call !== undefined,
          )
      : [];

    return {
      failedNode: failedNode ?? 'UNKNOWN',
      errorName: error instanceof Error ? error.name : 'UnknownError',
      ...(errorCode ? { errorCode } : {}),
      ...(causeCode ? { causeCode } : {}),
      ...(semanticInconsistencyType ? { semanticInconsistencyType } : {}),
      ...(semanticInconsistencyDetails ? { semanticInconsistencyDetails } : {}),
      ...(semanticCalls.length > 0 ? { semanticCalls } : {}),
    };
  }

  private semanticInconsistencyType(
    value: unknown,
  ): RagRouterSemanticInconsistencyType | undefined {
    return this.canonicalSemanticEnum(value, [
      'INVALID_INTENT',
      'INVALID_REFERENCE_TARGET',
      'INTENT_REFERENCE_MISMATCH',
      'SHARED_REEL_CONTEXT_UNAVAILABLE',
      'INTENT_REEL_TYPE_MISMATCH',
      'REQUIRED_EVIDENCE_MISMATCH',
      'INVALID_RECOMMENDATION_ACTION',
      'RECOMMENDATION_INTENT_MISMATCH',
      'RECOMMENDATION_PAYLOAD_MISMATCH',
    ] as const);
  }

  private safeSemanticInconsistencyDetails(
    value: unknown,
  ): RagRouterSemanticInconsistencyDetails | undefined {
    const record = this.asRecord(value);
    const details: RagRouterSemanticInconsistencyDetails = {};
    const actualIntent = this.canonicalSemanticEnum(record.actualIntent, [
      'NORMAL_CHAT',
      'REEL_VIDEO_QUESTION',
      'CONVERSATION_MEMORY_QUESTION',
      'USER_MEMORY_QUESTION',
      'TASK_ACTION_REQUEST',
    ] as const);
    const actualReferenceTarget = this.canonicalSemanticEnum(
      record.actualReferenceTarget,
      ['NONE', 'SHARED_REEL', 'CONVERSATION', 'USER_MEMORY'] as const,
    );
    const expectedReferenceTarget = this.canonicalSemanticEnum(
      record.expectedReferenceTarget,
      ['NONE', 'SHARED_REEL', 'CONVERSATION', 'USER_MEMORY'] as const,
    );
    const actualReelQuestionType = this.canonicalSemanticEnum(
      record.actualReelQuestionType,
      [
        'NONE',
        'TRANSCRIPT_CONTENT',
        'VISUAL_CONTENT',
        'GENERAL_REEL_SUMMARY',
        'REEL_METADATA',
        'AMBIGUOUS_REEL_REFERENCE',
      ] as const,
    );
    const expectedReelQuestionType = this.canonicalSemanticEnum(
      record.expectedReelQuestionType,
      [
        'NONE',
        'TRANSCRIPT_CONTENT',
        'VISUAL_CONTENT',
        'GENERAL_REEL_SUMMARY',
        'REEL_METADATA',
        'AMBIGUOUS_REEL_REFERENCE',
      ] as const,
    );
    const recommendationActionType = this.canonicalSemanticEnum(
      record.recommendationActionType,
      ['NONE', 'RECOMMEND_REELS', 'SUGGEST_QUERIES'] as const,
    );
    const actualEvidence = this.canonicalEvidence(record.actualEvidence);
    const expectedEvidence = this.canonicalEvidence(record.expectedEvidence);

    if (actualIntent) details.actualIntent = actualIntent;
    if (actualReferenceTarget)
      details.actualReferenceTarget = actualReferenceTarget;
    if (expectedReferenceTarget)
      details.expectedReferenceTarget = expectedReferenceTarget;
    if (actualReelQuestionType)
      details.actualReelQuestionType = actualReelQuestionType;
    if (expectedReelQuestionType)
      details.expectedReelQuestionType = expectedReelQuestionType;
    if (actualEvidence) details.actualEvidence = actualEvidence;
    if (expectedEvidence) details.expectedEvidence = expectedEvidence;
    if (recommendationActionType)
      details.recommendationActionType = recommendationActionType;

    return Object.keys(details).length > 0 ? details : undefined;
  }

  private canonicalEvidence(value: unknown): RagRequiredEvidence[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const values = [
      'NONE',
      'TRANSCRIPT',
      'VISUAL',
      'AUDIO',
      'METADATA',
      'CONVERSATION_MEMORY',
      'USER_MEMORY',
    ] as const;
    const normalized = value.filter((item): item is RagRequiredEvidence =>
      Boolean(this.canonicalSemanticEnum(item, values)),
    );
    return normalized.length === value.length ? normalized : undefined;
  }

  private canonicalSemanticEnum<T extends string>(
    value: unknown,
    values: readonly T[],
  ): T | undefined {
    return typeof value === 'string' && values.includes(value as T)
      ? (value as T)
      : undefined;
  }

  private toPersistedStructuredDiagnostic(
    value: unknown,
  ): RagStructuredCallFailureDiagnostic | undefined {
    const record = this.asRecord(value);
    if (
      typeof record.model !== 'string' ||
      !this.isStructuredProviderStatus(record.providerStatus) ||
      typeof record.latencyMs !== 'number' ||
      typeof record.configuredTimeoutMs !== 'number' ||
      typeof record.configuredMaxCompletionTokens !== 'number' ||
      typeof record.attempt !== 'number'
    ) {
      return undefined;
    }

    const diagnostic: RagStructuredCallFailureDiagnostic = {
      model: record.model,
      providerStatus: record.providerStatus,
      latencyMs: record.latencyMs,
      configuredTimeoutMs: record.configuredTimeoutMs,
      configuredMaxCompletionTokens: record.configuredMaxCompletionTokens,
      attempt: record.attempt,
      ...(this.optionalString(record.modelRole)
        ? { modelRole: this.optionalString(record.modelRole) }
        : {}),
      ...(this.optionalString(record.finishReason)
        ? { finishReason: this.optionalString(record.finishReason) }
        : {}),
      ...(this.optionalString(record.endpointContract)
        ? { endpointContract: this.optionalString(record.endpointContract) }
        : {}),
      ...(this.structuredJsonType(record.responseContentType)
        ? {
            responseContentType: this.structuredJsonType(
              record.responseContentType,
            ),
          }
        : {}),
      ...(typeof record.contentPresent === 'boolean'
        ? { contentPresent: record.contentPresent }
        : {}),
      ...(typeof record.toolCallsPresent === 'boolean'
        ? { toolCallsPresent: record.toolCallsPresent }
        : {}),
      ...(this.optionalString(record.errorCode)
        ? { errorCode: this.optionalString(record.errorCode) }
        : {}),
      ...(typeof record.providerCode === 'number' ||
      typeof record.providerCode === 'string'
        ? { providerCode: record.providerCode }
        : {}),
      ...(this.structuredProviderCategory(record.providerCategory)
        ? {
            providerCategory: this.structuredProviderCategory(
              record.providerCategory,
            ),
          }
        : {}),
      ...(typeof record.retryAfterMs === 'number'
        ? { retryAfterMs: record.retryAfterMs }
        : {}),
      ...(this.safeRateLimit(record.rateLimit)
        ? { rateLimit: this.safeRateLimit(record.rateLimit) }
        : {}),
      ...(typeof record.transient === 'boolean'
        ? { transient: record.transient }
        : {}),
      ...(this.optionalString(record.networkErrorName)
        ? { networkErrorName: this.optionalString(record.networkErrorName) }
        : {}),
      ...(this.optionalString(record.networkErrorCode)
        ? { networkErrorCode: this.optionalString(record.networkErrorCode) }
        : {}),
      ...(this.optionalString(record.networkErrorSyscall)
        ? {
            networkErrorSyscall: this.optionalString(
              record.networkErrorSyscall,
            ),
          }
        : {}),
      ...(this.optionalString(record.schemaPath)
        ? { schemaPath: this.optionalString(record.schemaPath) }
        : {}),
      ...(this.optionalString(record.schemaConstraint)
        ? { schemaConstraint: this.optionalString(record.schemaConstraint) }
        : {}),
      ...(this.optionalString(record.schemaVersion)
        ? { schemaVersion: this.optionalString(record.schemaVersion) }
        : {}),
      ...(this.structuredJsonType(record.expectedType)
        ? { expectedType: this.structuredJsonType(record.expectedType) }
        : {}),
      ...(this.structuredJsonType(record.actualJsonType)
        ? { actualJsonType: this.structuredJsonType(record.actualJsonType) }
        : {}),
      ...(this.safeUsage(record.usage)
        ? { usage: this.safeUsage(record.usage) }
        : {}),
    };

    return diagnostic;
  }

  private safeUsage(value: unknown):
    | {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        reasoningTokens?: number;
      }
    | undefined {
    const record = this.asRecord(value);
    const usage = Object.fromEntries(
      Object.entries({
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        totalTokens: record.totalTokens,
        reasoningTokens: record.reasoningTokens,
      }).filter(([, item]) => typeof item === 'number'),
    );
    return Object.keys(usage).length > 0 ? usage : undefined;
  }

  private safeRateLimit(
    value: unknown,
  ): RagStructuredCallFailureDiagnostic['rateLimit'] | undefined {
    const record = this.asRecord(value);
    const keys = [
      'retryAfter',
      'limitRequests',
      'limitTokens',
      'remainingRequests',
      'remainingTokens',
      'resetRequests',
      'resetTokens',
    ] as const;
    const result = Object.fromEntries(
      keys
        .map((key) => [key, this.optionalString(record[key])] as const)
        .filter(([, item]) => item !== undefined),
    ) as NonNullable<RagStructuredCallFailureDiagnostic['rateLimit']>;
    return Object.keys(result).length > 0 ? result : undefined;
  }

  private errorRecord(error: unknown): Record<string, unknown> {
    return this.asRecord(error);
  }

  private errorString(error: unknown, key: string): string | undefined {
    return this.optionalString(this.errorRecord(error)[key]);
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private isStructuredProviderStatus(
    value: unknown,
  ): value is RagStructuredCallFailureDiagnostic['providerStatus'] {
    return (
      (typeof value === 'number' && Number.isFinite(value)) ||
      value === 'NETWORK_ERROR' ||
      value === 'TIMEOUT'
    );
  }

  private structuredProviderCategory(
    value: unknown,
  ): RagStructuredCallFailureDiagnostic['providerCategory'] | undefined {
    return typeof value === 'string' &&
      [
        'AUTH_OR_CONFIGURATION_FAILURE',
        'ACCOUNT_LIMITED',
        'OUT_OF_CAPACITY',
        'PERMANENT_PROVIDER_FAILURE',
        'RATE_LIMITED',
        'TRANSIENT_PROVIDER_FAILURE',
        'UNKNOWN_PROVIDER_FAILURE',
      ].includes(value)
      ? (value as RagStructuredCallFailureDiagnostic['providerCategory'])
      : undefined;
  }

  private structuredJsonType(
    value: unknown,
  ): RagStructuredCallFailureDiagnostic['responseContentType'] | undefined {
    return typeof value === 'string' &&
      [
        'string',
        'array',
        'object',
        'number',
        'boolean',
        'null',
        'absent',
      ].includes(value)
      ? (value as RagStructuredCallFailureDiagnostic['responseContentType'])
      : undefined;
  }

  private formatRecentHistory(state: RagChatWorkflowState): string {
    const messages = boundRecentMessages(
      state.memory?.recentMessages ?? [],
      readRagPromptBounds(this.config),
    );

    if (messages.length === 0) {
      return '';
    }

    return messages
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join('\n');
  }

  private buildRouterReferentContext(state: RagChatWorkflowState) {
    const bounds = readRagPromptBounds(this.config);
    const allEventTypes = (state.memory?.recentMessages ?? [])
      .map((message) => message.eventType)
      .filter(
        (eventType): eventType is 'TEXT' | 'REEL_SHARE' =>
          eventType === 'TEXT' || eventType === 'REEL_SHARE',
      );
    const recentShareIndex = allEventTypes.lastIndexOf('REEL_SHARE');
    const recentEventTypes = allEventTypes.slice(-bounds.maxRouterEventTypes);
    if (
      recentShareIndex >= 0 &&
      recentShareIndex < allEventTypes.length - bounds.maxRouterEventTypes
    ) {
      recentEventTypes.unshift('REEL_SHARE');
    }
    const turnsSinceRecentShare =
      recentShareIndex < 0
        ? undefined
        : allEventTypes.length - recentShareIndex - 1;

    return {
      conversationHasSharedReelContext: state.hasSharedReelContext ?? false,
      accessibleSharedReelCount: state.accessibleReelIds?.length ?? 0,
      recentShareEvent:
        turnsSinceRecentShare !== undefined && turnsSinceRecentShare <= 2,
      turnsSinceRecentShare,
      recentEventTypes,
    };
  }

  private number(
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const parsed = Number(this.config.get<string>(key) ?? fallback);
    return Number.isFinite(parsed)
      ? Math.min(max, Math.max(min, parsed))
      : fallback;
  }

  private integer(
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    return Math.round(this.number(key, fallback, min, max));
  }
}
