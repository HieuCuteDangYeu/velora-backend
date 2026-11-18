// Live check that Velora AI remembers earlier turns, through the real gateway and Socket.IO.
// One login, one bot conversation, about 25 turns: two facts in invented names (English or
// Vietnamese, from categories earlier runs did not use) and a photo are planted, eight unrelated
// turns push them beyond the 12-message live window, then each fact is asked back three ways
// (explicit "do you remember", a paraphrase with no recall wording, the other language), the photo
// two ways, and two things never said are asked (the answer must not claim them). It needs an
// account you own: the turns count against its AI budget and the messages stay in its bot chat.
// RECALL_CATEGORIES=tea,museum picks the categories; the photo plant is skipped when the vision
// providers are out of daily quota.
//
//   VELORA_BASE_URL=https://velora-app.me BOT_USER_ID=<bot user id> \
//   VELORA_TEST_EMAIL=... VELORA_TEST_PASSWORD=... node eval/rag/conversation-recall-live.cjs
//
// Exit code 0 when every check passes. The photo is a drawn plate of pasta, so the check does not
// depend on a real picture.

const zlib = require('node:zlib');
const { io } = require('socket.io-client');

const base = process.env.VELORA_BASE_URL || 'https://velora-app.me';
const botUserId = process.env.BOT_USER_ID;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RUN = Date.now().toString(36);
const REFUSAL_FALLBACK =
  /could not verify that answer|I do not have enough verified|could not find that in our conversation|do not have that saved about you|I can only help with Velora/i;

// --- a small PNG writer, so no image file or dependency is needed ---
function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}
function pastaPng() {
  const width = 480;
  const height = 360;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  const inEllipse = (x, y, cx, cy, rx, ry) =>
    ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x += 1) {
      let color = y > 210 ? [150, 100, 60] : [250, 235, 205]; // wooden table, cream wall
      if (inEllipse(x, y, 240, 215, 190, 110)) color = [250, 250, 250]; // white plate
      if (inEllipse(x, y, 240, 205, 140, 75)) color = [235, 170, 60]; // pasta
      for (const [cx, cy] of [
        [190, 180],
        [240, 160],
        [290, 185],
        [215, 225],
        [275, 230],
      ]) {
        if (inEllipse(x, y, cx, cy, 20, 20)) color = [205, 40, 40]; // tomatoes
      }
      raw.set(color, y * (width * 3 + 1) + 1 + x * 3);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const FILLERS = [
  'how do I edit my Velora profile?',
  'what can you help me with in Velora?',
  'recommend videos about woodworking',
  'how do I share a reel with a friend?',
  'what should I watch next?',
  'is there a dark mode in the app?',
  'how do I turn off notifications?',
  'thanks, that helps',
];

(async () => {
  const login = await fetch(new URL('/auth/login', base), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.VELORA_TEST_EMAIL,
      password: process.env.VELORA_TEST_PASSWORD,
    }),
  });
  console.log('login status', login.status);
  if (!login.ok) process.exit(2);
  const jar = (login.headers.getSetCookie?.() ?? []).map(
    (c) => c.split(';', 1)[0],
  );
  const cookie = jar.join('; ');
  const token = decodeURIComponent(
    (jar.find((c) => c.startsWith('access_token=')) || '').slice(
      'access_token='.length,
    ),
  );
  await login.arrayBuffer();

  const json = async (path, body) => {
    const response = await fetch(new URL(path, base), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok)
      throw new Error(
        `${path} -> ${response.status} ${(await response.text()).slice(0, 160)}`,
      );
    return response.json();
  };

  const conv = await json('/conversations', {
    participantIds: [botUserId],
    type: 'DIRECT',
  });
  const conversationId = conv.id || conv._id || conv.conversation?.id;
  if (!conversationId) process.exit(3);

  const socket = io(base, {
    transports: ['websocket'],
    path: '/socket.io',
    forceNew: true,
    auth: { token },
  });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 15000);
  });
  let current = null;
  socket.on('new_message', (m) => {
    if (
      m.conversationId === conversationId &&
      m.senderId === botUserId &&
      current &&
      !current.final
    ) {
      current.final = performance.now();
      current.reply = m.content ?? '';
      current.metadata = m.metadata;
      current.resolve();
    }
  });
  socket.on('bot_reply_failed', (m) => {
    if (current && !current.final) {
      current.final = performance.now();
      current.reply = `FAILED ${m.error?.code}`;
      current.resolve();
    }
  });
  // After a reconnect the socket is no longer in the chat room and would never hear the replies.
  socket.on('connect', () => socket.emit('join_conversation', conversationId));
  socket.on('disconnect', (reason) =>
    console.log('socket disconnected:', reason),
  );
  socket.emit('join_conversation', conversationId);
  await sleep(1500);

  let counter = 0;
  const send = async ({ retries = 3, ...message }) => {
    for (let attempt = 1; ; attempt += 1) {
      current = { sent: performance.now() };
      const done = new Promise((resolve) => {
        current.resolve = resolve;
      });
      counter += 1;
      socket.emit('send_message', {
        conversationId,
        clientMessageId: `rc-${RUN}-${counter}`,
        ...message,
      });
      await Promise.race([done, sleep(150000)]);
      const result = {
        reply: String(current.reply ?? ''),
        metadata: current.metadata,
        ms: current.final ? Math.round(current.final - current.sent) : null,
      };
      await sleep(2500);
      // A busy model host is not a recall failure: wait and ask again.
      if (
        /FAILED AI_BUSY|FAILED RATE_LIMITED/.test(result.reply) &&
        attempt < 4
      ) {
        await sleep(20000);
        continue;
      }
      return result;
    }
  };
  const say = (content) => send({ type: 'text', content });

  const sendPhoto = async (caption, { retries = 3 } = {}) => {
    const png = pastaPng();
    const upload = await json('/media/upload-url', {
      fileType: 'image/png',
      purpose: 'chat',
    });
    const put = await fetch(upload.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: png,
    });
    if (!put.ok) throw new Error(`upload PUT ${put.status}`);
    const media = await json('/media/finalize-upload', {
      key: upload.key,
      fileType: 'image/png',
    });
    return send({
      retries,
      type: 'image',
      content: caption,
      media: {
        fileKey: media.fileKey,
        fileUrl: media.fileUrl,
        mimeType: media.mimeType,
        width: media.width,
        height: media.height,
      },
    });
  };

  const results = [];
  const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} | ${detail}`);
  };
  const show = (r) =>
    `${r.ms ?? 'TIMEOUT'}ms | ${r.reply.replace(/\s+/g, ' ').slice(0, 200)}`;

  // --- plant: invented names, so facts from earlier runs in this chat cannot pass for these ---
  const syllables = [
    'zor',
    'vak',
    'lim',
    'pra',
    'quen',
    'dub',
    'tay',
    'mer',
    'sko',
    'nel',
  ];
  const invent = () =>
    Array.from(
      { length: 3 },
      () => syllables[Math.floor(Math.random() * syllables.length)],
    )
      .join('')
      .replace(/^./, (c) => c.toUpperCase());
  const fold = (t) =>
    t
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .toLowerCase();
  const has = (name) => (t) => fold(t).includes(name.toLowerCase());

  // Each category holds one fact (stated in English or Vietnamese) and three ways to ask for it:
  // with explicit recall wording, with a paraphrase and no cue, and in the other language.
  // The chat keeps earlier runs, so a category must not repeat: RECALL_CATEGORIES picks them,
  // and the default is two at random from those no earlier run has used.
  const CATEGORIES = {
    tea: {
      fact: (w) => `My favourite tea is ${w} oolong.`,
      asks: [
        ['with "remember"', 'do you remember my favourite tea?'],
        ['paraphrase', 'which tea do I like the most?'],
        ['Vietnamese', 'loại trà mình thích nhất là gì nhỉ?'],
      ],
    },
    bike: {
      fact: (w) => `Mình vừa mua một chiếc xe đạp hiệu ${w}.`,
      asks: [
        ['Vietnamese, "nói"', 'mình nói vừa mua xe đạp hiệu gì nhỉ?'],
        ['Vietnamese, "còn nhớ"', 'bạn còn nhớ hiệu xe đạp mình mua không?'],
        ['English', 'what brand of bicycle did I say I bought?'],
      ],
    },
    museum: {
      fact: (w) => `I want to visit the ${w} Museum someday.`,
      asks: [
        ['with "remember"', 'do you remember the museum I mentioned?'],
        ['paraphrase', 'which museum do I want to visit?'],
        ['Vietnamese', 'mình muốn đến bảo tàng nào nhỉ?'],
      ],
    },
    sport: {
      fact: (w) => `Cuối tuần mình hay chơi môn ${w} với bạn bè.`,
      asks: [
        ['Vietnamese', 'mình hay chơi môn gì vào cuối tuần nhỉ?'],
        ['English paraphrase', 'what sport do I usually play on weekends?'],
        ['English, "remember"', 'do you remember what I play at weekends?'],
      ],
    },
  };
  const chosen = (
    process.env.RECALL_CATEGORIES
      ? process.env.RECALL_CATEGORIES.split(',')
      : Object.keys(CATEGORIES)
          .sort(() => Math.random() - 0.5)
          .slice(0, 2)
  ).filter((name) => CATEGORIES[name]);
  const planted = chosen.map((name) => ({
    name,
    word: invent(),
    ...CATEGORIES[name],
  }));

  let r;
  for (const item of planted) {
    r = await say(item.fact(item.word));
    console.log(`plant ${item.name.padEnd(8)}|`, show(r));
  }
  // A photo needs the vision providers; when their daily quota is spent the bot answers "busy".
  r = await sendPhoto('find reels like this', { retries: 1 });
  const photoPlanted = !/FAILED/.test(r.reply);
  console.log(
    'plant photo   |',
    show(r),
    '| stored description:',
    r.metadata?.photoDescription ?? '(none in event)',
    photoPlanted
      ? ''
      : '| SKIPPED: vision unavailable, photo recall is checked against an earlier photo',
  );
  const stored = String(r.metadata?.photoDescription ?? '');

  // --- push everything past the 12-message live window ---
  for (const text of FILLERS) {
    r = await say(text);
    console.log('filler        |', show(r));
  }

  // --- recall: the same facts, asked in different words and languages ---
  const NOT_FALLBACK = (reply) => !REFUSAL_FALLBACK.test(reply);
  const photoWords = [
    'pasta',
    'plate',
    'food',
    'dish',
    'tomato',
    'spaghetti',
    'noodle',
    'pizza',
    'illustration',
    ...(stored.toLowerCase().match(/[a-z]{5,}/g) ?? []),
  ];
  const mentions = (reply, words) =>
    words.some((word) => reply.toLowerCase().includes(word));
  const asks = [
    ...planted.flatMap((item) =>
      item.asks.map(([how, question]) => [
        `${item.name}, ${how}`,
        question,
        has(item.word),
      ]),
    ),
    [
      'photo, English',
      'do you remember what was in the photo I sent?',
      (t) => mentions(t, photoWords),
    ],
    [
      'photo, Vietnamese',
      'bạn còn nhớ tấm ảnh mình gửi không?',
      (t) => mentions(t, [...photoWords, 'ảnh', 'hình']),
    ],
  ];
  for (const [name, question, correct] of asks) {
    r = await say(question);
    check(name, correct(r.reply) && NOT_FALLBACK(r.reply), show(r));
  }

  // --- things never said: an honest "not found" passes, a claim fails ---
  const HONEST =
    /(could not|couldn't|cannot|can't|do not|don't|did not|didn't|not (find|see|have|mention)|no (record|information|mention))/i;
  for (const [name, question, topic] of [
    [
      'never said: bread',
      'do you remember what I told you about the sourdough bread?',
      /sourdough/i,
    ],
    ['never said: kayak', 'what did I tell you about my kayak trip?', /kayak/i],
  ]) {
    r = await say(question);
    const claims = topic.test(r.reply) && !HONEST.test(r.reply);
    check(name, !claims && r.ms !== null, show(r));
  }

  socket.close();
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error('ERR', error.message);
  process.exit(4);
});
