// Builds eval/rag/datasets/rag-conversation-recall-v1.jsonl: questions about earlier chat turns,
// asked after a long history, so recall can be measured at every distance.
//
//   node eval/rag/conversation-recall-dataset.cjs
//
// Seeded and deterministic: the same command writes the same file. A case is one chat history
// (oldest first, as conversation-service sends it) plus a question and what a correct recall
// must contain. `distance` is how many messages back the answer sits; the live window holds the
// last 12, so a ranker only matters from distance 13.
//
// Case kinds: `lexical` (the question repeats a word of the fact), `semantic` (it shares no
// word), `vietnamese`, `photo` (the answer is a photo caption and the AI's description of it),
// `negative` (nothing in the history answers it; the right recall is empty).

const fs = require('node:fs');
const path = require('node:path');

const SEED = 20261119;
const DISTANCES = [14, 20, 30, 50, 70];
const INSIDE_WINDOW = [4, 9];
const OUT_OF_REACH = [100];

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = rng(SEED);
const pick = (list) => list[Math.floor(random() * list.length)];

// What a person says to the Velora bot that is not a fact worth recalling, and the bot's real replies.
const FILLER_USER = [
  'hi',
  'sup',
  'hello again',
  'thanks',
  'thank you, that helps',
  'what can you help me with in Velora?',
  'how do I edit my Velora profile?',
  'recommend videos about woodworking',
  'show me funny reels',
  'what should I watch next?',
  'how do I share a reel with a friend?',
  'what r ur available tool calling?',
  'ok',
  'lol',
  'can you find reels like the last one?',
  'how do I turn off notifications?',
  'is there a dark mode?',
  'who are you?',
  'what is the weather today?',
  'write me a poem',
  'chào bạn',
  'cảm ơn nhé',
  'bạn giúp được gì cho mình?',
  'gợi ý cho mình vài video hài',
  'làm sao để đổi ảnh đại diện?',
  'ok cảm ơn',
];
const FILLER_BOT = [
  'sup! How can I help you with Velora today?',
  'I can only help with Velora: its Reels and videos, what to watch next, your chats here, and using the app. Ask me about one of those and I’ll jump in.',
  'Here are some reels for "woodworking":',
  'Here are some reels you might like:',
  'You can edit your profile from the Profile tab: tap Edit profile.',
  'Happy to help! Anything else about Velora?',
  'To share a reel, tap the share icon and pick a friend.',
  'Mình có thể giúp bạn tìm video, gợi ý reel và hướng dẫn dùng Velora.',
  'Đây là vài reel dành cho bạn:',
];

// Each fact: what the user says, the question forms that ask about it, and words the recall must contain.
const FACTS = [
  {
    id: 'carbonara',
    say: 'I love making spaghetti carbonara on weekends',
    lexical: 'do you remember the spaghetti I mentioned earlier?',
    semantic: 'what food did I say I like cooking?',
    expect: ['carbonara'],
    topic: 'food',
  },
  {
    id: 'guitar',
    say: 'I just started learning classical guitar',
    lexical: 'what instrument did I say I was learning, the guitar one?',
    semantic: 'which musical thing did I tell you I picked up recently?',
    expect: ['guitar'],
    topic: 'hobby',
  },
  {
    id: 'hanoi',
    say: 'I am travelling to Hanoi next month for my cousin’s wedding',
    lexical: 'when am I going to Hanoi again?',
    semantic: 'where did I say I am travelling to?',
    expect: ['Hanoi'],
    topic: 'travel',
  },
  {
    id: 'golden',
    say: 'my dog is a golden retriever called Biscuit',
    lexical: 'what was my dog Biscuit again?',
    semantic: 'what is my pet called?',
    expect: ['Biscuit'],
    topic: 'pet',
  },
  {
    id: 'vegan',
    say: 'I am vegan so please avoid recommending meat cooking videos',
    lexical: 'do you remember I am vegan?',
    semantic: 'what did I tell you about my diet?',
    expect: ['vegan'],
    topic: 'food',
  },
  {
    id: 'marathon',
    say: 'I am training for the Da Nang marathon in March',
    lexical: 'which marathon am I training for?',
    semantic: 'what race did I say I am preparing for?',
    expect: ['marathon'],
    topic: 'sport',
  },
  {
    id: 'python',
    say: 'I work as a backend developer and mostly write Python',
    lexical: 'what language did I say I write, Python?',
    semantic: 'what do I do for a living?',
    expect: ['Python'],
    topic: 'work',
  },
  {
    id: 'sneakers',
    say: 'I want to buy white leather sneakers under 50 dollars',
    lexical: 'what sneakers was I looking to buy?',
    semantic: 'what shopping did I say I planned?',
    expect: ['sneakers'],
    topic: 'shopping',
  },
  {
    id: 'sister',
    say: 'my sister Linh is visiting me from Da Lat this weekend',
    lexical: 'when is my sister Linh visiting?',
    semantic: 'which family member did I say was coming over?',
    expect: ['Linh'],
    topic: 'family',
  },
  {
    id: 'budget',
    say: 'my monthly budget for streaming and apps is 15 dollars',
    lexical: 'what was my monthly budget for apps?',
    semantic: 'how much money did I say I can spend each month?',
    expect: ['15'],
    topic: 'money',
  },
  {
    id: 'ghibli',
    say: 'my favourite movie is Spirited Away by Studio Ghibli',
    lexical: 'what was that Ghibli movie I like?',
    semantic: 'which film did I say is my favourite?',
    expect: ['Spirited Away'],
    topic: 'media',
  },
  {
    id: 'coffee',
    say: 'I drink only black coffee with no sugar',
    lexical: 'how do I take my coffee?',
    semantic: 'what did I say about my morning drink?',
    expect: ['coffee'],
    topic: 'food',
  },
];
// Distractors that share a topic with a fact, so ranking cannot lean on topic alone.
const DISTRACTORS = [
  'I had a burger for lunch yesterday',
  'my friend plays the piano really well',
  'we went to Hue last year',
  'my neighbour has a cat',
  'I run a little bit most mornings',
  'my manager likes Java',
  'I saw a nice jacket at the mall',
  'my brother is moving to Saigon',
  'I read about saving money on subscriptions',
  'I watched a documentary about the ocean',
];
const VIETNAMESE_FACTS = [
  {
    id: 'vi-pho',
    say: 'mình rất thích nấu phở bò vào cuối tuần',
    question: 'bạn còn nhớ món mình hay nấu cuối tuần không?',
    expect: ['phở'],
  },
  {
    id: 'vi-dalat',
    say: 'tháng sau mình sẽ đi Đà Lạt với gia đình',
    question: 'mình nói sẽ đi du lịch ở đâu nhỉ?',
    expect: ['Đà Lạt'],
  },
  {
    id: 'vi-meo',
    say: 'mình có một con mèo tên là Mướp',
    question: 'thú cưng của mình tên gì?',
    expect: ['Mướp'],
  },
  {
    id: 'vi-guitar',
    say: 'mình đang tập chơi đàn ghi-ta',
    question: 'mình đang học nhạc cụ nào ấy nhỉ?',
    expect: ['ghi-ta'],
  },
];
const PHOTOS = [
  {
    id: 'photo-pasta',
    line: '[Photo] find reels like this shows: a plate of pasta with tomato sauce and basil',
    reply: 'Here are some reels for "pasta dinner":',
    questions: [
      'do you remember about the pasta i mentioned above?',
      'what was in the photo I sent?',
      'what did the picture I shared show?',
    ],
    expect: ['pasta'],
  },
  {
    id: 'photo-beach',
    line: '[Photo] any videos like this? shows: a sunset over a sandy beach with palm trees',
    reply: 'Here are some reels for "sunset beach":',
    questions: [
      'what was the photo I sent earlier about?',
      'do you remember the beach picture?',
      'what did the image I uploaded show?',
    ],
    expect: ['beach'],
  },
  {
    id: 'photo-sneaker',
    line: '[Photo] where can I see this? shows: a pair of red running sneakers on a track',
    reply: 'Here are some reels for "running sneakers":',
    questions: [
      'what shoes were in the picture I sent?',
      'do you remember the sneakers photo?',
      'what did the photo I uploaded show?',
    ],
    expect: ['sneakers'],
  },
];
const NEGATIVES = [
  'do you remember the piano I mentioned?',
  'what did I say about my job at the bank?',
  'which city did I say I was moving to?',
  'what is my favourite colour that I told you?',
  'do you remember what my grandmother cooked?',
  'what did I tell you about the exam?',
  'which car did I say I wanted to buy?',
  'bạn còn nhớ mình nói về cây đàn violin không?',
];

const fillerPair = () => [
  { role: 'user', content: pick(FILLER_USER) },
  { role: 'assistant', content: pick(FILLER_BOT) },
];

/** `distance` messages sit after the gold message; fillers pad both sides to a fixed length. */
function buildHistory({ goldMessages, distance, distractors }) {
  const messages = [];
  const before = 6 + Math.floor(random() * 6);
  for (let i = 0; i < before; i += 1) messages.push(...fillerPair());
  messages.push(...goldMessages);
  const after = [];
  while (after.length < distance - (goldMessages.length - 1)) {
    after.push(...fillerPair());
  }
  after.length = distance - (goldMessages.length - 1);
  for (const text of distractors) {
    const slot = Math.floor(random() * after.length);
    after[slot] = { role: 'user', content: text };
  }
  messages.push(...after);
  return messages;
}

const stamp = (messages) =>
  messages.map((message, index) => ({
    ...message,
    createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, index)).toISOString(),
  }));

const cases = [];
const add = (entry) =>
  cases.push({
    id: `recall-${String(cases.length + 1).padStart(3, '0')}`,
    ...entry,
  });
const distractorsFor = (topicWords) => {
  const pool = DISTRACTORS.filter(
    (text) => !topicWords.some((w) => text.includes(w)),
  );
  return [pick(pool), pick(pool)];
};

for (const distance of [...INSIDE_WINDOW, ...DISTANCES, ...OUT_OF_REACH]) {
  for (const fact of FACTS) {
    for (const form of ['lexical', 'semantic']) {
      const history = buildHistory({
        goldMessages: [{ role: 'user', content: fact.say }],
        distance,
        distractors: distractorsFor(fact.expect),
      });
      add({
        kind: form,
        distance,
        question: fact[form],
        expect: fact.expect,
        history: stamp(history),
      });
    }
  }
  for (const fact of VIETNAMESE_FACTS) {
    const history = buildHistory({
      goldMessages: [{ role: 'user', content: fact.say }],
      distance,
      distractors: distractorsFor([]),
    });
    add({
      kind: 'vietnamese',
      distance,
      question: fact.question,
      expect: fact.expect,
      history: stamp(history),
    });
  }
  for (const photo of PHOTOS) {
    // A photo and the bot's reply are two messages; the photo line is the gold one.
    const history = buildHistory({
      goldMessages: [
        { role: 'user', content: photo.line },
        { role: 'assistant', content: photo.reply },
      ],
      distance,
      distractors: distractorsFor([]),
    });
    add({
      kind: 'photo',
      distance,
      question: pick(photo.questions),
      expect: photo.expect,
      history: stamp(history),
    });
  }
}
for (const question of NEGATIVES) {
  for (const distance of [20, 50]) {
    const fact = pick(FACTS);
    const history = buildHistory({
      goldMessages: [{ role: 'user', content: fact.say }],
      distance,
      distractors: distractorsFor(fact.expect),
    });
    add({
      kind: 'negative',
      distance,
      question,
      expect: [],
      history: stamp(history),
    });
  }
}

const out = path.join(
  __dirname,
  'datasets',
  'rag-conversation-recall-v1.jsonl',
);
fs.writeFileSync(out, `${cases.map((c) => JSON.stringify(c)).join('\n')}\n`);
const byKind = cases.reduce(
  (acc, c) => ({ ...acc, [c.kind]: (acc[c.kind] ?? 0) + 1 }),
  {},
);
console.log(
  `wrote ${cases.length} cases to ${path.relative(process.cwd(), out)}`,
  byKind,
);
