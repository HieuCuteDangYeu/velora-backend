export interface IContextToolAgentPolicy {
  model?: string;
  maxSteps: number;
  maxParallelCalls: number;
  callTimeoutMs: number;
}
