import { Injectable } from '@nestjs/common';

/**
 * Vectors of recent chat messages, so a recall question embeds only the question and whatever
 * is new. The embedding service takes about a second per text and shares its capacity with
 * reel search, so embedding twenty messages on the spot can run past the recall timeout.
 * In memory and per process: a miss only costs the embedding call, and a restart starts cold.
 */
@Injectable()
export class MessageEmbeddingCache {
  private readonly maxEntries = 1_500;
  private readonly entries = new Map<string, Float32Array>();

  /** Same key for the whole message and its shortened copy, which differ after the cut. */
  static key(text: string): string {
    return text.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 280);
  }

  get(text: string): Float32Array | undefined {
    const key = MessageEmbeddingCache.key(text);
    const vector = this.entries.get(key);
    if (vector) {
      // Re-insert so the least recently used entry is the one evicted.
      this.entries.delete(key);
      this.entries.set(key, vector);
    }
    return vector;
  }

  set(text: string, values: readonly number[]): void {
    const key = MessageEmbeddingCache.key(text);
    if (!key) return;
    this.entries.delete(key);
    this.entries.set(key, Float32Array.from(values));
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
