import { asksForReelsLikePhoto } from './rag-photo-reel-request';

describe('asksForReelsLikePhoto', () => {
  it.each([
    'find reels like this',
    'Any videos similar to this?',
    'show me clips about it',
    'tìm video giống cái này',
    'có phim tương tự không?',
    '找类似的视频',
  ])('accepts %s', (caption) => {
    expect(asksForReelsLikePhoto(caption)).toBe(true);
  });

  it.each([
    'solve this problem',
    'what is this?',
    'translate the text',
    'how much is the total?',
    '',
  ])('rejects %s', (caption) => {
    expect(asksForReelsLikePhoto(caption)).toBe(false);
  });
});
