import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * A chat turn that summarises a long stretch of one video ("Summarize what is said from 7:17 to 14:45"). The local
 * model has a 4,096-token context and ordinary calls already use up to about 3,800 tokens, so a long range cannot be
 * read in full there: the turn reads the whole range and sends its structured calls to the large-context remote
 * model instead (AI_LONG_RANGE_REMOTE=true). The flag is per turn, set once the question is known.
 */
interface TurnScope {
  longRange: boolean;
}

const storage = new AsyncLocalStorage<TurnScope>();

/** Seconds above which a range summary counts as long. */
export const LONG_RANGE_SECONDS = 300;
/** Evidence a long-range turn may carry (chunk count and characters). */
export const LONG_RANGE_EVIDENCE_ITEMS = 120;
export const LONG_RANGE_EVIDENCE_CHARS = 16_000;

export function runTurnScope<T>(work: () => Promise<T>): Promise<T> {
  return storage.run({ longRange: false }, work);
}

export function markLongRangeTurn(): void {
  const scope = storage.getStore();
  if (scope) scope.longRange = true;
}

export function isLongRangeTurn(): boolean {
  return storage.getStore()?.longRange === true;
}
