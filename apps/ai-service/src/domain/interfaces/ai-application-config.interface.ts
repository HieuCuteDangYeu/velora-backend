export type AiModelRole =
  | 'ROUTER'
  | 'RETRIEVAL_PLANNER'
  | 'RETRIEVAL_TOOL'
  | 'CONTEXT_SUFFICIENCY'
  | 'ANSWER'
  | 'ANSWER_REVISION'
  | 'VERIFIER'
  | 'VERIFIER_ESCALATION'
  | 'CITATION_ATTRIBUTION'
  | 'INDEX_QUALITY'
  | 'METADATA_EXTRACTION'
  | 'SUBTITLE_TRANSLATION'
  | 'SECTION_SUMMARY'
  | 'VISION'
  | 'TRANSCRIPTION'
  | 'EMBEDDING'
  | 'RERANKER'
  | 'CONVERSATION_SUMMARY'
  | 'MEMORY_EXTRACTION';

export type AiCompletionRole = Exclude<
  AiModelRole,
  'VISION' | 'TRANSCRIPTION' | 'EMBEDDING' | 'RERANKER'
>;

export interface IAiApplicationConfig {
  get<T = string>(key: string): T | undefined;
  model(role: AiModelRole): string;
  timeoutMs(role: AiModelRole): number;
  maxCompletionTokens(role: AiCompletionRole): number;
  boolean(key: string, fallback: boolean): boolean;
  number(key: string, fallback: number, min: number, max: number): number;
}
