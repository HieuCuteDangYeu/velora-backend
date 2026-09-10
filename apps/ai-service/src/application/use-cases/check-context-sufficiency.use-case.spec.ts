import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import type { RagChatWorkflowState } from '@ai/domain/interfaces/rag-chat-workflow.interface';
import { CheckContextSufficiencyUseCase } from './check-context-sufficiency.use-case';

describe('CheckContextSufficiencyUseCase', () => {
  const config = {
    model: jest.fn(() => 'test/test/sufficiency'),
    timeoutMs: jest.fn(() => 6_000),
    maxCompletionTokens: jest.fn(() => 512),
  } as unknown as IAiApplicationConfig;

  const state = (input: {
    requiredEvidence?: Array<'TRANSCRIPT' | 'VISUAL' | 'AUDIO' | 'METADATA'>;
    evidenceType?: 'TRANSCRIPT' | 'VISUAL' | 'METADATA';
    evidenceText?: string;
  }): RagChatWorkflowState =>
    ({
      userMessage: 'What semantic relation is asserted?',
      route: {
        needsRetrieval: true,
        requiredEvidence: input.requiredEvidence ?? ['TRANSCRIPT'],
      },
      rerankedChunks: input.evidenceText
        ? [
            {
              evidenceType: input.evidenceType ?? 'TRANSCRIPT',
              evidenceText: input.evidenceText,
              chunkText: input.evidenceText,
              tags: [],
            },
          ]
        : [],
    }) as unknown as RagChatWorkflowState;

  it('refuses deterministically when no evidence exists', async () => {
    const service = { generateObject: jest.fn() };
    const useCase = new CheckContextSufficiencyUseCase(
      service as never,
      config,
    );

    await expect(useCase.execute(state({}))).resolves.toMatchObject({
      sufficient: false,
      missingEvidence: ['TRANSCRIPT'],
      supportedEvidenceIds: [],
      recommendedAction: 'REFUSE_NO_CONTEXT',
      diagnostics: { decisionSource: 'DETERMINISTIC_NO_CONTEXT' },
    });
    expect(service.generateObject).not.toHaveBeenCalled();
  });

  it('refuses deterministically when the required modality is absent', async () => {
    const service = { generateObject: jest.fn() };
    const useCase = new CheckContextSufficiencyUseCase(
      service as never,
      config,
    );

    await expect(
      useCase.execute(
        state({
          requiredEvidence: ['VISUAL'],
          evidenceType: 'TRANSCRIPT',
          evidenceText: 'A speaker discusses a glyph.',
        }),
      ),
    ).resolves.toMatchObject({
      sufficient: false,
      missingEvidence: ['VISUAL'],
      supportedEvidenceIds: [],
      diagnostics: { decisionSource: 'DETERMINISTIC_REQUIRED_MODALITY' },
    });
    expect(service.generateObject).not.toHaveBeenCalled();
  });

  it.each([
    ['supports an unseen relation', true, 'ANSWER'],
    ['contains only a nearby topic', false, 'REFUSE_NO_CONTEXT'],
  ])(
    'uses the semantic decision when evidence %s',
    async (_description, sufficient, recommendedAction) => {
      const service = {
        generateObject: jest.fn().mockResolvedValue({
          sufficient,
          confidence: 0.87,
          availableEvidence: ['TRANSCRIPT'],
          missingEvidence: sufficient ? [] : ['TRANSCRIPT'],
          supportedEvidenceIds: sufficient ? ['e0'] : [],
          reason: 'Semantic evidence judgment.',
          userFacingReason: sufficient ? '' : 'The relation is unsupported.',
          recommendedAction,
        }),
      };
      const useCase = new CheckContextSufficiencyUseCase(
        service as never,
        config,
      );

      await expect(
        useCase.execute(
          state({ evidenceText: 'A novel relation appears in this passage.' }),
        ),
      ).resolves.toMatchObject({
        sufficient,
        supportedEvidenceIds: sufficient ? ['e0'] : [],
        diagnostics: { providerStatus: 'SUCCESS', decisionSource: 'LLM' },
      });
      expect(service.generateObject).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'test/test/sufficiency',
          timeoutMs: 6_000,
          temperature: 0,
          schemaVersion: 'context-sufficiency-v2',
        }),
      );
      const schema = service.generateObject.mock.calls[0][0].jsonSchema;
      expect(schema.required).not.toEqual(
        expect.arrayContaining(['availableEvidence', 'missingEvidence']),
      );
      expect(schema.properties).toMatchObject({
        confidence: { minimum: 0, maximum: 1 },
        supportedEvidenceIds: { maxItems: 8 },
        reason: { maxLength: 400 },
        userFacingReason: { maxLength: 300 },
      });
      expect(service.generateObject.mock.calls[0][0].systemPrompt).toContain(
        'minimal set of supplied evidence items that directly supports answering the exact user question',
      );
      expect(service.generateObject.mock.calls[0][0].systemPrompt).toContain(
        'Use REWRITE_AND_RETRY only when typed evidence exists',
      );
      expect(service.generateObject.mock.calls[0][0].systemPrompt).toContain(
        'Transcript ASR may contain punctuation',
      );
    },
  );

  it('persists safe structured-call diagnostics from the sufficiency provider', async () => {
    const service = {
      generateObject: jest
        .fn()
        .mockImplementation(
          (input: { onDiagnostics?: (value: unknown) => void }) => {
            input.onDiagnostics?.({
              modelRole: 'CONTEXT_SUFFICIENCY',
              model: 'test/test/sufficiency',
              providerStatus: 200,
              attempt: 1,
            });
            return Promise.resolve({
              sufficient: true,
              confidence: 0.9,
              supportedEvidenceIds: ['e0'],
              reason: 'Supported.',
              recommendedAction: 'ANSWER',
            });
          },
        ),
    };
    const useCase = new CheckContextSufficiencyUseCase(
      service as never,
      config,
    );

    await expect(
      useCase.execute(state({ evidenceText: 'Authorized evidence.' })),
    ).resolves.toMatchObject({
      diagnostics: {
        semanticCalls: [
          expect.objectContaining({
            modelRole: 'CONTEXT_SUFFICIENCY',
            providerStatus: 200,
            attempt: 1,
          }),
        ],
      },
    });
  });

  it('filters provider evidence IDs that were not supplied', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue({
        sufficient: true,
        confidence: 1,
        availableEvidence: ['TRANSCRIPT'],
        missingEvidence: [],
        supportedEvidenceIds: ['e0', 'e99'],
        reason: 'Supported.',
        userFacingReason: '',
        recommendedAction: 'ANSWER',
      }),
    };
    const useCase = new CheckContextSufficiencyUseCase(
      service as never,
      config,
    );

    await expect(
      useCase.execute(state({ evidenceText: 'Authorized evidence.' })),
    ).resolves.toMatchObject({ supportedEvidenceIds: ['e0'] });
  });

  it('preserves multiple valid support IDs while deduplicating them', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue({
        sufficient: true,
        confidence: 0.9,
        supportedEvidenceIds: ['e0', 'e1', 'e0'],
        reason: 'Both supplied items directly support the relation.',
        userFacingReason: '',
        recommendedAction: 'ANSWER',
      }),
    };
    const useCase = new CheckContextSufficiencyUseCase(
      service as never,
      config,
    );
    const multiEvidenceState = {
      ...state({ evidenceText: 'First support.' }),
      rerankedChunks: [
        {
          evidenceType: 'TRANSCRIPT',
          evidenceText: 'First support.',
          chunkText: 'First support.',
          tags: [],
        },
        {
          evidenceType: 'TRANSCRIPT',
          evidenceText: 'Second support.',
          chunkText: 'Second support.',
          tags: [],
        },
      ],
    } as RagChatWorkflowState;

    await expect(useCase.execute(multiEvidenceState)).resolves.toMatchObject({
      sufficient: true,
      supportedEvidenceIds: ['e0', 'e1'],
    });
  });

  it('fails closed when the semantic provider is unavailable', async () => {
    const service = {
      generateObject: jest.fn().mockRejectedValue(new Error('down')),
    };
    const useCase = new CheckContextSufficiencyUseCase(
      service as never,
      config,
    );

    await expect(
      useCase.execute(state({ evidenceText: 'Potential evidence.' })),
    ).resolves.toMatchObject({
      sufficient: false,
      confidence: 0,
      supportedEvidenceIds: [],
      diagnostics: { providerStatus: 'ERROR', decisionSource: 'FAIL_CLOSED' },
    });
  });
});
