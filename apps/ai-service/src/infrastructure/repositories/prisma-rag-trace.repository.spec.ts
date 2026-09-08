import type { RagTraceCreateInput } from '@ai/domain/interfaces/rag-trace.repository.interface';
import { PrismaRagTraceRepository } from './prisma-rag-trace.repository';

describe('PrismaRagTraceRepository', () => {
  it('round-trips route and final citation provenance without changing public citations', async () => {
    const stored = {
      id: 'trace-1',
      userId: 'user-1',
      conversationId: 'conversation-1',
      message: 'Question?',
      intent: 'REEL_VIDEO_QUESTION',
      needsRetrieval: true,
      retrievedChunkIds: ['reel:r1:chunk:0'],
      rerankedChunkIds: ['reel:r1:chunk:0'],
      citations: [
        {
          sourceType: 'REEL',
          reelId: 'r1',
          evidenceType: 'TRANSCRIPT',
          title: null,
          startTime: 1,
          endTime: 2,
          quote: 'Grounded quote',
        },
      ],
      answer: 'Answer.',
      verifierPassed: true,
      verifierConfidence: 1,
      verifierIssues: [],
      latencyMs: 10,
      nodeTimings: { citationNode: 2 },
      workflowMetrics: {
        retrievalRetryCount: 0,
        answerRetryCount: 0,
        citationRetryCount: 0,
        citationEvidenceIds: ['reel:r1:chunk:0'],
        citationSelectedEvidenceIds: ['e0'],
        deterministicSupportingEvidenceIds: [],
        citationEvidenceMappings: [
          {
            citationIndex: 0,
            selectedEvidenceId: 'e0',
            evidenceId: 'reel:r1:chunk:0',
          },
        ],
        diagnostics: {
          route: {
            modelRole: 'ROUTER',
            model: 'test/test/router',
            providerStatus: 'SUCCESS',
            decisionSource: 'LLM',
            requestId: 'must-not-persist',
          },
          routeDecision: {
            intent: 'REEL_VIDEO_QUESTION',
            referenceTarget: 'SHARED_REEL',
            reelQuestionType: 'TRANSCRIPT_CONTENT',
            requiredEvidence: ['TRANSCRIPT'],
            needsRetrieval: true,
            needsVerification: true,
            recommendationActionType: 'NONE',
          },
        },
      },
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    const create = jest.fn().mockResolvedValue(stored);
    const repository = new PrismaRagTraceRepository({
      ragTrace: { create },
    } as never);
    const input: RagTraceCreateInput = {
      userId: 'user-1',
      conversationId: 'conversation-1',
      message: 'Question?',
      intent: 'REEL_VIDEO_QUESTION',
      needsRetrieval: true,
      retrievedChunkIds: ['reel:r1:chunk:0'],
      rerankedChunkIds: ['reel:r1:chunk:0'],
      citations: [
        {
          sourceType: 'REEL',
          reelId: 'r1',
          evidenceType: 'TRANSCRIPT',
          quote: 'Grounded quote',
        },
      ],
      workflowMetrics: stored.workflowMetrics,
    };

    const trace = await repository.create(input);
    const data = create.mock.calls[0][0].data;

    expect(data.citations[0]).not.toHaveProperty('evidenceId');
    expect(JSON.stringify(data.workflowMetrics)).not.toContain(
      'must-not-persist',
    );
    expect(data.workflowMetrics).toEqual(
      expect.objectContaining({
        citationEvidenceIds: ['reel:r1:chunk:0'],
        citationSelectedEvidenceIds: ['e0'],
        citationEvidenceMappings: [
          {
            citationIndex: 0,
            selectedEvidenceId: 'e0',
            evidenceId: 'reel:r1:chunk:0',
          },
        ],
        diagnostics: expect.objectContaining({
          routeDecision: expect.objectContaining({
            referenceTarget: 'SHARED_REEL',
            reelQuestionType: 'TRANSCRIPT_CONTENT',
            requiredEvidence: ['TRANSCRIPT'],
          }),
          route: expect.objectContaining({ modelRole: 'ROUTER' }),
        }),
      }),
    );
    expect(trace.workflowMetrics).toEqual(
      expect.objectContaining({
        citationEvidenceIds: ['reel:r1:chunk:0'],
        citationSelectedEvidenceIds: ['e0'],
        citationEvidenceMappings: [
          {
            citationIndex: 0,
            selectedEvidenceId: 'e0',
            evidenceId: 'reel:r1:chunk:0',
          },
        ],
        diagnostics: expect.objectContaining({
          routeDecision: expect.objectContaining({
            referenceTarget: 'SHARED_REEL',
          }),
        }),
      }),
    );
  });
});
