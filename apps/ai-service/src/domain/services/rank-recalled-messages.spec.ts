import type { AiChatMessageContext } from '@common/ai/interfaces/chat-memory-context.interface';
import {
  cosineSimilarity,
  lexicalRecallScores,
  rankRecalledMessages,
  recallTokens,
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
});
