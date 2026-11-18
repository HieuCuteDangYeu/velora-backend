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
    'Mình đã hỏi bạn gì lúc nãy?',
    'What do you remember about my favourite topics?',
    'what tabletop game do I like best?',
    'trò chơi cờ bàn mình thích nhất là gì nhỉ?',
    'mình hay mua cà phê ở quán nào nhỉ?',
    'what is my lizard called?',
    'which coffee shop do I usually go to?',
    'where am I travelling next month?',
    'what’s my favourite movie?',
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
    'Remember that I like short answers.',
    'remember to be brief',
    'Hướng dẫn trước đó trong video là gì?',
    'video ở trên có gì vậy?',
    'which one do I like more, this or that?',
    'what do I need to upload a reel?',
    'what is my username?',
    'mình nên xem gì?',
    'what do I do with this reel?',
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
