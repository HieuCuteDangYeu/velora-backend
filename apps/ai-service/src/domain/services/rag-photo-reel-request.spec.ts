import { asksForReelsLikePhoto } from './rag-photo-reel-request';

describe('asksForReelsLikePhoto', () => {
  it.each([
    'find reels like this',
    'Any videos similar to this?',
    'show me clips about it',
    'tìm video giống cái này',
    'có phim tương tự không?',
    '找类似的视频',
    'what is this from?',
    'Which show is this from',
    'where was this taken from?',
    'what is the source of this',
    'cái này từ đâu vậy?',
  ])('accepts %s', (caption) => {
    expect(asksForReelsLikePhoto(caption)).toBe(true);
  });

  it.each([
    'solve this problem',
    'what is this?',
    'what is this made from?',
    'where is the nearest cafe?',
    'translate the text',
    'how much is the total?',
    '',
  ])('rejects %s', (caption) => {
    expect(asksForReelsLikePhoto(caption)).toBe(false);
  });
});
