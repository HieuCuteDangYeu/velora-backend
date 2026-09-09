import type {
  GenerateStructuredObjectInput,
  IStructuredLlmService,
} from '@ai/domain/interfaces/structured-llm.service.interface';
import type { ConfigService } from '@nestjs/config';
import { StructuredLlmCitationAttributionAdapter } from './structured-llm-citation-attribution.adapter';

describe('StructuredLlmCitationAttributionAdapter', () => {
  const aiConfig = {
    model: jest.fn(() => 'test/test/citation'),
    timeoutMs: jest.fn(() => 4_000),
    maxCompletionTokens: jest.fn(() => 768),
  };
  const createConfig = (values: Record<string, string> = {}) =>
    ({
      get: jest.fn((key: string) => values[key]),
      getOrThrow: jest.fn((key: string) => {
        if (key === 'AI_CITATION_ATTRIBUTION_MODEL') {
          return values[key] ?? 'test/test/citation';
        }
        const value = values[key];
        if (!value) throw new Error(`Missing ${key}`);
        return value;
      }),
    }) as unknown as ConfigService;

  it('rejects claim mappings containing unknown evidence IDs', async () => {
    const structuredLlmService: IStructuredLlmService = {
      generateObject: jest.fn().mockResolvedValue({
        claims: [
          {
            claim: 'The screen shows a module-not-found error.',
            supported: true,
            evidenceIds: ['e0', 'invented'],
            confidence: 0.92,
          },
          {
            claim: 'It is caused by a production dependency.',
            supported: true,
            evidenceIds: ['e1'],
            confidence: 0.2,
          },
        ],
      }),
    };
    const adapter = new StructuredLlmCitationAttributionAdapter(
      structuredLlmService,
      createConfig(),
      aiConfig as never,
    );

    await expect(
      adapter.attribute({
        question: 'What error is visible?',
        answer:
          'The screen shows a module-not-found error caused by a production dependency.',
        maxCitations: 3,
        candidates: [
          {
            evidenceId: 'e0',
            reelId: 'r1',
            evidenceType: 'VISUAL',
            evidenceText: 'Visible text: Cannot find module @nestjs/config',
          },
          {
            evidenceId: 'e1',
            reelId: 'r1',
            evidenceType: 'TRANSCRIPT',
            evidenceText: 'The speaker says they are debugging the app.',
          },
        ],
      }),
    ).resolves.toEqual({
      selections: [],
      claims: [
        {
          claim: 'The screen shows a module-not-found error.',
          supported: false,
          evidenceIds: [],
          confidence: 0.92,
        },
        {
          claim: 'It is caused by a production dependency.',
          supported: false,
          evidenceIds: [],
          confidence: 0.2,
        },
      ],
      factualClaimCount: 2,
      supportedClaimCount: 0,
      coverage: 0,
      diagnostics: {
        modelRole: 'CITATION_ATTRIBUTION',
        model: 'test/test/citation',
        providerStatus: 'SUCCESS',
      },
    });

    expect(structuredLlmService.generateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'test/test/citation',
        temperature: 0,
        timeoutMs: 4_000,
      }),
    );
  });

  it('returns full coverage when the answer contains no factual claims', async () => {
    const structuredLlmService: IStructuredLlmService = {
      generateObject: jest.fn().mockResolvedValue({ claims: [] }),
    };
    const adapter = new StructuredLlmCitationAttributionAdapter(
      structuredLlmService,
      createConfig(),
      aiConfig as never,
    );

    await expect(
      adapter.attribute({
        question: 'What is visible?',
        answer: 'I cannot determine that from the available evidence.',
        maxCitations: 3,
        candidates: [
          {
            evidenceId: 'e0',
            reelId: 'r1',
            evidenceType: 'VISUAL',
            evidenceText: 'A laptop is visible.',
          },
        ],
      }),
    ).resolves.toEqual({
      selections: [],
      claims: [],
      factualClaimCount: 0,
      supportedClaimCount: 0,
      coverage: 1,
      diagnostics: {
        modelRole: 'CITATION_ATTRIBUTION',
        model: 'test/test/citation',
        providerStatus: 'SUCCESS',
      },
    });
  });

  it('uses a strict-compatible citation schema', async () => {
    const generateObject = jest.fn().mockResolvedValue({ claims: [] });
    const structuredLlmService: IStructuredLlmService = { generateObject };
    const adapter = new StructuredLlmCitationAttributionAdapter(
      structuredLlmService,
      createConfig(),
      aiConfig as never,
    );

    await adapter.attribute({
      question: 'What is visible?',
      answer: 'A laptop is visible.',
      maxCitations: 3,
      candidates: [
        {
          evidenceId: 'e0',
          reelId: 'r1',
          evidenceType: 'VISUAL',
          evidenceText: 'A laptop is visible.',
        },
      ],
    });

    const request = generateObject.mock
      .calls[0][0] as GenerateStructuredObjectInput;
    const validateStrictSchema = (schema: unknown, path: string): void => {
      expect(schema).toBeDefined();
      expect(schema).toEqual(
        expect.objectContaining({ type: expect.any(String) }),
      );
      const record = schema as Record<string, unknown>;
      const type = record.type;
      expect(['object', 'array', 'string', 'boolean', 'number']).toContain(
        type,
      );

      if (type === 'object') {
        const properties = (record.properties ?? {}) as Record<string, unknown>;
        const required = Array.isArray(record.required)
          ? (record.required as string[])
          : [];
        expect(record.additionalProperties).toBe(false);
        expect(new Set(required)).toEqual(new Set(Object.keys(properties)));
        for (const [key, propertySchema] of Object.entries(properties)) {
          validateStrictSchema(propertySchema, `${path}.${key}`);
        }
      }

      if (type === 'array' && record.items) {
        validateStrictSchema(record.items, `${path}[]`);
      }
    };

    validateStrictSchema(request.jsonSchema, '$');
    expect(request.modelRole).toBe('CITATION_ATTRIBUTION');
    expect(request.jsonSchema).toMatchObject({
      type: 'object',
      required: ['claims'],
      additionalProperties: false,
    });
  });

  it('preserves safe structured-call diagnostics when attribution fails', async () => {
    const structuredLlmService: IStructuredLlmService = {
      generateObject: jest
        .fn()
        .mockImplementation((input: GenerateStructuredObjectInput) => {
          input.onDiagnostics?.({
            modelRole: 'CITATION_ATTRIBUTION',
            model: 'test/test/citation',
            providerStatus: 429,
            latencyMs: 4_000,
            configuredTimeoutMs: 4_000,
            configuredMaxCompletionTokens: 768,
            attempt: 1,
            errorCode: 'STRUCTURED_COMPLETION_PROVIDER_ERROR',
            providerCategory: 'OUT_OF_CAPACITY',
            requestId: 'must-not-persist',
          });
          return Promise.reject(new Error('provider failed'));
        }),
    };
    const adapter = new StructuredLlmCitationAttributionAdapter(
      structuredLlmService,
      createConfig(),
      aiConfig as never,
    );

    const error = await adapter
      .attribute({
        question: 'What is visible?',
        answer: 'A red diagram is visible.',
        maxCitations: 3,
        candidates: [
          {
            evidenceId: 'e0',
            reelId: 'r1',
            evidenceType: 'VISUAL',
            evidenceText: 'A red diagram is visible.',
          },
        ],
      })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'CITATION_ATTRIBUTION_PROVIDER_ERROR',
      semanticCalls: [
        expect.objectContaining({
          providerStatus: 429,
          providerCategory: 'OUT_OF_CAPACITY',
        }),
      ],
    });
    expect(JSON.stringify(error)).not.toContain('must-not-persist');
    expect(structuredLlmService.generateObject).toHaveBeenCalledTimes(1);
  });
});
