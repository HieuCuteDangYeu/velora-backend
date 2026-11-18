import type { AiChatMessageContext } from '@common/ai/interfaces/chat-memory-context.interface';
import {
  cosineSimilarity,
  lexicalRecallScores,
  rankRecalledMessages,
  recallTokens,
  strongRecallMatch,
  formatRecallQuote,
  selectEmbeddingCandidates,
  isPhotoQuestion,
} from './rank-recalled-messages';

const message = (
  content: string,
  role: 'user' | 'assistant' = 'user',
): AiChatMessageContext => ({
  role,
  content,
  createdAt: '2026-11-19T00:00:00Z',
});

describe('rankRecalledMessages', () => {
  it('drops question scaffolding and folds Vietnamese diacritics', () => {
    expect(
      recallTokens('Do you remember what pasta I mentioned earlier?'),
    ).toEqual(['pasta']);
    expect(recallTokens('Tôi thích phở bò')).toEqual(
      recallTokens('toi thich pho bo'),
    );
  });

  it('finds a message by shared topic words and ignores the rest', () => {
    const candidates = [
      message('I love making spaghetti carbonara on weekends'),
      message('How do I edit my profile?'),
      message('what tools do you have?'),
    ];
    expect(
      rankRecalledMessages({
        question: 'do you remember the spaghetti I mentioned?',
        candidates,
      }),
    ).toEqual([candidates[0]]);
  });

  it('weights a rare word above one every message shares', () => {
    const scores = lexicalRecallScores('velora carbonara', [
      'velora is great',
      'velora profile',
      'carbonara tonight',
    ]);
    expect(scores[2]).toBeGreaterThan(scores[0]);
  });

  it('finds a message by meaning when no word is shared', () => {
    const candidates = [
      message('I love making spaghetti carbonara on weekends'),
      message('How do I edit my profile?'),
    ];
    expect(
      rankRecalledMessages({
        question: 'what food did I mention?',
        candidates,
        semantic: [0.62, 0.21],
      }),
    ).toEqual([candidates[0]]);
  });

  it('returns nothing when no message is relevant by meaning or words', () => {
    const candidates = [message('How do I edit my profile?')];
    expect(
      rankRecalledMessages({
        question: 'what food did I mention?',
        candidates,
        semantic: [0.2],
      }),
    ).toEqual([]);
  });

  it('keeps the best few and returns them oldest first', () => {
    const candidates = [
      message('pasta recipe one'),
      message('unrelated'),
      message('pasta recipe two'),
      message('pasta recipe three'),
    ];
    const result = rankRecalledMessages({
      question: 'pasta recipe',
      candidates,
      options: { limit: 2 },
    });
    expect(result).toHaveLength(2);
    expect(candidates.indexOf(result[0])).toBeLessThan(
      candidates.indexOf(result[1]),
    );
  });

  it('falls back to word match for a candidate whose embedding is missing', () => {
    const candidates = [
      message('spaghetti dinner'),
      message('profile settings'),
    ];
    expect(
      rankRecalledMessages({
        question: 'spaghetti',
        candidates,
        semantic: [undefined, 0.1],
      }),
    ).toEqual([candidates[0]]);
  });

  it('computes cosine similarity and tolerates mismatched vectors', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [1])).toBe(0);
  });

  it('treats a photo line as relevant to a question about a photo, ahead of generic messages', () => {
    const candidates = [
      message('what should I watch next?'),
      message(
        '[Photo] any videos like this? shows: a sunset over a sandy beach',
      ),
      message('write me a poem'),
    ];
    expect(isPhotoQuestion('what did the image I uploaded show?')).toBe(true);
    expect(isPhotoQuestion('Bạn còn nhớ tấm hình mình gửi không?')).toBe(true);
    expect(isPhotoQuestion('what food did I mention?')).toBe(false);
    expect(
      rankRecalledMessages({
        question: 'what did the image I uploaded show?',
        candidates,
        semantic: [0.52, 0.4, 0.3],
      }),
    ).toEqual([candidates[1]]);
  });

  it('keeps only matches close to the best one', () => {
    const candidates = [message('first match'), message('second match')];
    const ranked = (margin: number) =>
      rankRecalledMessages({
        question: 'match',
        candidates,
        semantic: [0.9, 0.55],
        options: { margin },
      });
    expect(ranked(0.05)).toEqual([candidates[0]]);
    expect(ranked(0.5)).toEqual(candidates);
  });

  it('picks the newest substantive user messages for embedding, once each', () => {
    const candidates = [
      message('hi'),
      message('my favourite food is pasta'),
      message('Here are some reels for pasta', 'assistant'),
      message('my favourite food is pasta'),
      message('ok'),
      message('I am travelling to Hanoi soon'),
    ];
    expect(selectEmbeddingCandidates(candidates, 10)).toEqual([3, 5]);
    expect(selectEmbeddingCandidates(candidates, 1)).toEqual([5]);
  });

  it('prefers the statement over a question about the same thing asked earlier', () => {
    const candidates = [
      message('I am travelling to Hanoi next month'),
      message('where am I travelling next month?'),
    ];
    const question = 'where did I say I am travelling?';
    expect(
      rankRecalledMessages({ question, candidates, semantic: [0.62, 0.7] }),
    ).toEqual([candidates[0]]);
    // asking about what was asked is the one case where the earlier question is the answer
    expect(
      rankRecalledMessages({
        question: 'what did I ask you about travelling?',
        candidates,
        semantic: [0.62, 0.7],
      }),
    ).toEqual([candidates[1]]);
  });

  describe('strongRecallMatch and formatRecallQuote', () => {
    it('quotes a confident match by meaning or by words, newest first on a tie', () => {
      const candidates = [
        message('I love making spaghetti carbonara'),
        message('I just started learning guitar'),
        message('I love making spaghetti carbonara'),
      ];
      expect(
        strongRecallMatch({
          question: 'what food do I like cooking?',
          candidates,
          semantic: [0.65, 0.3, 0.65],
        }),
      ).toBe(candidates[2]);
      expect(
        strongRecallMatch({
          question: 'what did I say about the spaghetti carbonara?',
          candidates: [candidates[0]],
        }),
      ).toBe(candidates[0]);
    });

    it('stays silent for a weak match, an assistant line and a question the user asked earlier', () => {
      const candidates = [
        message('how do I edit my profile?'),
        message('where am I travelling next month?'),
        message('Here are some reels about travelling next month', 'assistant'),
      ];
      expect(
        strongRecallMatch({
          question: 'where did I say I am travelling next month?',
          candidates,
          semantic: [0.45, 0.8, 0.8],
        }),
      ).toBeUndefined();
      // ...unless the question is about what was asked
      expect(
        strongRecallMatch({
          question: 'what did I ask you about travelling next month?',
          candidates,
          semantic: [0.45, 0.8, 0.8],
        }),
      ).toBe(candidates[1]);
    });

    it('quotes a photo line as the photo and what it showed', () => {
      expect(
        formatRecallQuote(
          message('[Photo] find reels like this shows: a plate of pasta'),
        ),
      ).toBe(
        'You sent a photo with the caption “find reels like this”. It showed: a plate of pasta',
      );
      expect(formatRecallQuote(message('[Photo]'))).toBe('You sent a photo.');
      expect(formatRecallQuote(message('my dog is called Biscuit'))).toBe(
        'Earlier you wrote: “my dog is called Biscuit”',
      );
    });
  });
});
