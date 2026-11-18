import { MessageEmbeddingCache } from './message-embedding-cache';

describe('MessageEmbeddingCache', () => {
  it('finds a vector regardless of spacing and case, and by the shortened copy of a long text', () => {
    const cache = new MessageEmbeddingCache();
    cache.set('I love  Spaghetti carbonara ', [1, 2, 3]);
    expect(Array.from(cache.get('i love spaghetti CARBONARA')!)).toEqual([
      1, 2, 3,
    ]);
    const long = `${'word '.repeat(80)}tail`;
    cache.set(long, [4]);
    expect(cache.get(`${long.slice(0, 299)}…`)).toBeDefined();
  });

  it('evicts the least recently used entry first', () => {
    const cache = new MessageEmbeddingCache();
    for (let index = 0; index < 1_500; index += 1) {
      cache.set(`message number ${index}`, [index]);
    }
    cache.get('message number 0'); // now the most recently used
    cache.set('one more message', [1]);
    expect(cache.size).toBe(1_500);
    expect(cache.get('message number 0')).toBeDefined();
    expect(cache.get('message number 1')).toBeUndefined();
  });
});
