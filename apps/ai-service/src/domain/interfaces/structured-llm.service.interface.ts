export interface StructuredLlmJsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export type StructuredProviderFailureCategory =
  | 'ACCOUNT_LIMITED'
  | 'AUTH_OR_CONFIGURATION_FAILURE'
  | 'OUT_OF_CAPACITY'
  | 'RATE_LIMITED'
  | 'PERMANENT_PROVIDER_FAILURE'
  | 'TRANSIENT_PROVIDER_FAILURE'
  | 'UNKNOWN_PROVIDER_FAILURE';

export interface StructuredRateLimitDiagnostics {
  retryAfter?: string;
  limitRequests?: string;
  limitTokens?: string;
  remainingRequests?: string;
  remainingTokens?: string;
  resetRequests?: string;
  resetTokens?: string;
}

export type StructuredJsonType =
  | 'string'
  | 'array'
  | 'object'
  | 'number'
  | 'boolean'
  | 'null'
  | 'absent';

export interface StructuredLlmCallDiagnostics {
  modelRole?: string;
  model: string;
  providerStatus: number | 'NETWORK_ERROR' | 'TIMEOUT';
  latencyMs: number;
  configuredTimeoutMs: number;
  configuredMaxCompletionTokens: number;
  finishReason?: string;
  endpointContract?: string;
  responseContentType?: StructuredJsonType;
  contentPresent?: boolean;
  toolCallsPresent?: boolean;
  attempt: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
  };
  errorCode?: string;
  providerCode?: number | string;
  providerCategory?: StructuredProviderFailureCategory;
  retryAfterMs?: number;
  rateLimit?: StructuredRateLimitDiagnostics;
  requestId?: string;
  networkErrorName?: string;
  networkErrorCode?: string;
  networkErrorSyscall?: string;
  transient?: boolean;
  schemaPath?: string;
  schemaConstraint?: string;
  schemaVersion?: string;
  expectedType?: StructuredJsonType;
  actualJsonType?: StructuredJsonType;
}

export interface GenerateStructuredObjectInput {
  model?: string;
  systemPrompt: string;
  userPrompt: string;
  jsonSchema: StructuredLlmJsonSchema;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  modelRole?: string;
  schemaVersion?: string;
  attempt?: number;
  onDiagnostics?: (diagnostics: StructuredLlmCallDiagnostics) => void;
}

export interface IStructuredLlmService {
  generateObject<T>(input: GenerateStructuredObjectInput): Promise<T>;
}
