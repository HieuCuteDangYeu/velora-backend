import { LangfuseSpanProcessor } from '@langfuse/otel';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';

const DEFAULT_SAMPLE_RATE = 0.1;

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
        baseUrl:
          env.LANGFUSE_BASE_URL?.trim() || 'https://cloud.langfuse.com',
        environment:
          env.LANGFUSE_TRACING_ENVIRONMENT?.trim() ||
          env.NODE_ENV?.trim() ||
          'development',
        release: env.LANGFUSE_RELEASE?.trim() || env.RELEASE_SHA?.trim(),
        flushAt: 20,
        flushInterval: 5,
        mediaUploadEnabled: false,
        mask: ({ data }) => redactLangfuseValue(data),
      }),
    ],
  });
}

/** Keep payloads useful for correlation while dropping prompt/context content. */
export function redactLangfuseValue(value: unknown, key?: string): unknown {
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
    return value.slice(0, 32).map((item) => redactLangfuseValue(item));
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
