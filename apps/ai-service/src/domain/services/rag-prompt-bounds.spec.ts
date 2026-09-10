import {
  boundRecentMessages,
  boundTextItems,
  boundEvidence,
  DEFAULT_RAG_PROMPT_BOUNDS,
  truncateEvidenceText,
  truncatePromptText,
} from './rag-prompt-bounds';

describe('rag prompt bounds', () => {
  it('bounds pathological recent history by count and total characters', () => {
    const messages = Array.from({ length: 12 }, (_, index) => ({
      role: 'user',
      content: `message-${index} ${'x'.repeat(2_000)}`,
    }));

    const bounded = boundRecentMessages(messages, DEFAULT_RAG_PROMPT_BOUNDS);

    expect(bounded.length).toBeLessThanOrEqual(
      DEFAULT_RAG_PROMPT_BOUNDS.maxRecentMessages,
    );
    expect(bounded.at(-1)?.content.length).toBeLessThanOrEqual(
      DEFAULT_RAG_PROMPT_BOUNDS.maxRecentMessageChars,
    );
    expect(
      bounded.reduce((total, item) => total + item.content.length, 0),
    ).toBeLessThanOrEqual(DEFAULT_RAG_PROMPT_BOUNDS.maxRecentTotalChars);
  });

  it('bounds memory/evidence-style item collections by total characters', () => {
    const bounded = boundTextItems(
      Array.from({ length: 8 }, (_, index) => ({
        id: index,
        text: 'evidence '.repeat(500),
      })),
      (item) => item.text,
      (item, text) => ({ ...item, text }),
      DEFAULT_RAG_PROMPT_BOUNDS.maxMemories,
      DEFAULT_RAG_PROMPT_BOUNDS.maxMemoryItemChars,
      DEFAULT_RAG_PROMPT_BOUNDS.maxMemoryTotalChars,
    );

    expect(bounded.length).toBeLessThanOrEqual(
      DEFAULT_RAG_PROMPT_BOUNDS.maxMemories,
    );
    expect(
      bounded.reduce((total, item) => total + item.text.length, 0),
    ).toBeLessThanOrEqual(DEFAULT_RAG_PROMPT_BOUNDS.maxMemoryTotalChars);
  });

  it('truncates on a word boundary and marks the truncation', () => {
    const value = truncatePromptText('alpha beta gamma delta epsilon', 16);
    expect(value.endsWith('...')).toBe(true);
    expect(value).not.toContain('epsilon');
  });

  it('preserves evidence tails when a fact may occur near the chunk end', () => {
    const value = truncateEvidenceText(
      'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda omega',
      36,
    );

    expect(value.length).toBeLessThanOrEqual(36);
    expect(value.startsWith('alpha')).toBe(true);
    expect(value.endsWith('omega')).toBe(true);
    expect(value).toContain('...');
  });

  it('bounds evidence metadata without changing finite match labels', () => {
    const [bounded] = boundEvidence(
      [
        {
          chunkId: 'chunk-1',
          reelId: 'reel-1',
          title: 'title '.repeat(100),
          description: 'description '.repeat(100),
          tags: Array.from({ length: 20 }, () => 'tag '.repeat(30)),
          chunkText: 'grounded evidence',
          evidenceText: 'grounded evidence',
          evidenceType: 'TRANSCRIPT',
          distance: 0.1,
          matchedBy: 'HYBRID',
        },
      ],
      DEFAULT_RAG_PROMPT_BOUNDS,
    );

    expect(bounded.title?.length).toBeLessThanOrEqual(
      DEFAULT_RAG_PROMPT_BOUNDS.maxEvidenceTitleChars,
    );
    expect(bounded.description?.length).toBeLessThanOrEqual(
      DEFAULT_RAG_PROMPT_BOUNDS.maxEvidenceDescriptionChars,
    );
    expect(bounded.tags).toHaveLength(
      DEFAULT_RAG_PROMPT_BOUNDS.maxEvidenceTags,
    );
    expect(
      bounded.tags.every(
        (tag) => tag.length <= DEFAULT_RAG_PROMPT_BOUNDS.maxEvidenceTagChars,
      ),
    ).toBe(true);
    expect(bounded.matchedBy).toBe('HYBRID');
  });
});
