import { looksLikeRecallQuestion } from './recall-cue';

describe('looksLikeRecallQuestion', () => {
  it.each([
    'do u remember about the pasta i mentioned above?',
    'Do you remember the spaghetti I mentioned earlier?',
    'what did I say about my dog?',
    'which instrument did I tell you I was learning?',
    'did I ever mention my sister?',
    'what was the photo I sent earlier about?',
    'can you recall what I asked you before?',
    'as I mentioned earlier, which one was it?',
    'bạn còn nhớ món mình hay nấu cuối tuần không?',
    'mình nói sẽ đi du lịch ở đâu nhỉ?',
    'hồi nãy mình gửi ảnh gì vậy?',
    'bạn có nhớ không?',
    'what did the image I uploaded show?',
    'tấm ảnh mình gửi lúc nãy là gì?',
  ])('flags: %s', (message) => {
    expect(looksLikeRecallQuestion(message)).toBe(true);
  });

  it.each([
    'hi',
    'recommend videos about woodworking',
    'remember to recommend funny reels',
    'what should I watch next?',
    'how do I edit my Velora profile?',
    'what is the weather today?',
    'can you find reels like the last one?',
    'write me a poem',
    'I mentioned my dog to a friend yesterday and they laughed',
    'mình nói thật nhé',
    'gợi ý cho mình vài video hài',
    'cảm ơn nhé',
    'làm sao để đổi ảnh đại diện?',
    'show me what is trending before I go to bed',
    'how do I share a reel with a friend?',
    'how do I send a photo to my friend?',
    'do I share my location with the app?',
  ])('does not flag: %s', (message) => {
    expect(looksLikeRecallQuestion(message)).toBe(false);
  });
});
