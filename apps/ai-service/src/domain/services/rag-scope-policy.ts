export interface RagScopeConfig {
  get<T = string>(key: string): T | undefined;
}

/**
 * `enforce` keeps the assistant on Velora (its Reels and videos, the user's own chat and
 * memory, using the app); anything else gets a fixed redirect. `off` restores open-ended
 * chat, e.g. if the router turns out to refuse too much. Default: enforce.
 */
export type RagScopeMode = 'off' | 'enforce';

export function readRagScopeMode(config?: RagScopeConfig): RagScopeMode {
  const raw = config?.get('AI_SCOPE_MODE');
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'off'
    ? 'off'
    : 'enforce';
}
