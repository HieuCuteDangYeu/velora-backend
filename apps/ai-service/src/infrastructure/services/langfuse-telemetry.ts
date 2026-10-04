import { LangfuseSpanProcessor } from '@langfuse/otel';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';

const DEFAULT_SAMPLE_RATE = 1;

export function langfuseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.LANGFUSE_ENABLED?.trim().toLowerCase() === 'true' &&
    Boolean(env.LANGFUSE_PUBLIC_KEY?.trim()) &&
    Boolean(env.LANGFUSE_SECRET_KEY?.trim())
  );
}

function sampleRate(env: NodeJS.ProcessEnv): number {
  const value = Number(env.LANGFUSE_SAMPLE_RATE ?? DEFAULT_SAMPLE_RATE);
  return Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : DEFAULT_SAMPLE_RATE;
}

export function createLangfuseSdk(
  env: NodeJS.ProcessEnv = process.env,
): NodeSDK | undefined {
  if (!langfuseEnabled(env)) return undefined;

  return new NodeSDK({
    serviceName: env.OTEL_SERVICE_NAME?.trim() || 'velora-ai-service',
    sampler: new TraceIdRatioBasedSampler(sampleRate(env)),
    spanProcessors: [
      new LangfuseSpanProcessor({
        publicKey: env.LANGFUSE_PUBLIC_KEY,
        secretKey: env.LANGFUSE_SECRET_KEY,
        baseUrl: env.LANGFUSE_BASE_URL?.trim() || 'https://cloud.langfuse.com',
        environment:
          env.LANGFUSE_TRACING_ENVIRONMENT?.trim() ||
          env.NODE_ENV?.trim() ||
          'development',
        release: env.LANGFUSE_RELEASE?.trim() || env.RELEASE_SHA?.trim(),
        flushAt: 20,
        flushInterval: 5,
        mediaUploadEnabled: false,
        mask: ({ data }) => maskLangfuseData(data),
      }),
    ],
  });
}

/** Keep payloads useful for correlation while dropping prompt/context content. */
export function redactLangfuseValue(value: unknown, key?: string): unknown {
  if ((key === 'query' || key === 'response') && typeof value === 'string') {
    return process.env.LANGFUSE_CAPTURE_CONTENT?.trim().toLowerCase() === 'true'
      ? value.slice(0, key === 'query' ? 2_000 : 4_000)
      : '[REDACTED]';
  }
  if (
    key &&
    /^(requestId|authorization|cookie|password|secret|apiKey)$/i.test(key)
  )
    return undefined;
  if (key === 'generationEvidence') {
    return process.env.AI_RAG_CAPTURE_EVALUATION_CONTEXT?.trim().toLowerCase() ===
      'true'
      ? evaluationEvidence(value)
      : '[REDACTED]';
  }
  if (
    key &&
    (/(prompt|message|context|transcript|quote|content)(?:$|text|data|value)/i.test(
      key,
    ) ||
      /^answer$/i.test(key))
  ) {
    return '[REDACTED]';
  }

  if (typeof value === 'string') {
    return value.length > 200 ? '[REDACTED]' : value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactLangfuseValue(item, key));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(
        ([entryKey, entryValue]) => [
          entryKey,
          redactLangfuseValue(entryValue, entryKey),
        ],
      ),
    );
  }

  return value;
}

const SNAPSHOT_STRING_KEYS = new Set([
  'actualJsonType',
  'availableEvidence',
  'decisionSource',
  'endpointContract',
  'errorCode',
  'evidenceType',
  'expectedType',
  'failureSource',
  'finishReason',
  'indexVersion',
  'intent',
  'model',
  'modelRole',
  'missingEvidence',
  'networkErrorCode',
  'networkErrorName',
  'networkErrorSyscall',
  'provider',
  'providerCategory',
  'providerCode',
  'providerStatus',
  'recommendedAction',
  'referenceTarget',
  'requiredEvidence',
  'reelQuestionType',
  'recommendationActionType',
  'responseContentType',
  'schemaConstraint',
  'schemaPath',
  'schemaVersion',
  'scope',
  'sourceType',
  'status',
  'usageSource',
  'version',
  'release',
  'embeddingProvider',
  'embeddingModel',
  'embeddingVersion',
  'finalFailureSource',
  'finalSource',
  'answerGenerationStatus',
  'groundingVerification',
  'finalizationMode',
  'fallbackReason',
  'verifierDecision',
  'citationCoverageMode',
  'actualIntent',
  'actualReelQuestionType',
  'actualEvidence',
  'expectedEvidence',
  'semanticInconsistencyType',
  'toolName',
  'toolStatus',
]);

/** Diagnostic strings are allowlisted; user/provider free text stays private. */
export function sanitizeRagSnapshot(value: unknown, key = ''): unknown {
  if (key === 'requestId') return undefined;
  if (key === 'generationEvidence') {
    return process.env.AI_RAG_CAPTURE_EVALUATION_CONTEXT?.trim().toLowerCase() ===
      'true'
      ? evaluationEvidence(value)
      : undefined;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    return SNAPSHOT_STRING_KEYS.has(key) ||
      /(?:Id|Ids)$/.test(key) ||
      key === 'mode' ||
      key === 'sourceOrder' ||
      key === 'source' ||
      key === 'failedNode' ||
      key === 'errorName' ||
      key === 'causeCode'
      ? value.slice(0, 500)
      : undefined;
  }
  if (Array.isArray(value))
    return value
      .map((item) => sanitizeRagSnapshot(item, key))
      .filter((item) => item !== undefined);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .map(([childKey, child]) => [
          childKey,
          sanitizeRagSnapshot(child, childKey),
        ])
        .filter(([, child]) => child !== undefined),
    );
  return undefined;
}

/** The SDK mask receives serialized OTEL attributes, not parsed objects. */
export function maskLangfuseData(data: unknown): unknown {
  if (typeof data !== 'string') return redactLangfuseValue(data);
  try {
    return JSON.stringify(redactLangfuseValue(JSON.parse(data)));
  } catch {
    return '[REDACTED]';
  }
}

function evaluationEvidence(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  return value.map((item: Record<string, unknown>) =>
    Object.fromEntries(
      [
        'evidenceId',
        'sourceId',
        'reelId',
        'evidenceType',
        'evidenceText',
        'indexVersion',
        'startTime',
        'endTime',
      ]
        .filter((key) => item && item[key] !== undefined)
        .map((key) => [key, item[key]]),
    ),
  );
}
