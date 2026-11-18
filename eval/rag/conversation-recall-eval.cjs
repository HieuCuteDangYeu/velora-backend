// Scores the conversation-recall ranker on rag-conversation-recall-v1.jsonl with real embeddings.
//
//   node eval/rag/conversation-recall-dataset.cjs                       # writes the dataset
//   node eval/rag/conversation-recall-eval.cjs --vectors vectors.json   # scores it
//   node eval/rag/conversation-recall-eval.cjs --texts > texts.json     # texts to embed
//
// Mirrors what conversation-service and ai-service do: the last 12 messages are the live window
// (always visible), the 80 before them are candidates (the newest 60 are scored), and the ranker
// returns at most 4. A case is a hit when the live window or the recalled messages contain the
// expected words. Negative cases want an empty recall.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const dataset = fs
  .readFileSync(
    path.join(__dirname, 'datasets', 'rag-conversation-recall-v1.jsonl'),
    'utf8',
  )
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));

if (args.includes('--texts')) {
  const texts = new Set();
  for (const row of dataset) {
    texts.add(row.question);
    for (const message of row.history) texts.add(message.content);
  }
  process.stdout.write(JSON.stringify([...texts]));
  process.exit(0);
}

const load = (file) => {
  const source = fs.readFileSync(file, 'utf8');
  const out = ts.transpileModule(source, {
    compilerOptions: { module: 'commonjs', target: 'es2022' },
  });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', out.outputText)(
    module,
    module.exports,
    require,
  );
  return module.exports;
};
const ranker = load(
  path.join(
    __dirname,
    '..',
    '..',
    'apps/ai-service/src/domain/services/rank-recalled-messages.ts',
  ),
);

const vectorsFile = flag('--vectors');
const vectors = vectorsFile
  ? JSON.parse(fs.readFileSync(vectorsFile, 'utf8'))
  : undefined;

const LIVE_WINDOW = 12;
const OLDER_WINDOW = 80;
const SCORED = 60;

function run(row, options) {
  const messages = row.history;
  const recent = messages.slice(-LIVE_WINDOW);
  const older = messages
    .slice(0, Math.max(0, messages.length - LIVE_WINDOW))
    .slice(-OLDER_WINDOW);
  const candidates = older.slice(-SCORED);
  const embedMax = options.embedMax ?? 20;
  const embedded = new Set(
    ranker.selectEmbeddingCandidates(candidates, embedMax),
  );
  const semantic = vectors
    ? candidates.map((message, index) =>
        embedded.has(index) && vectors[message.content] && vectors[row.question]
          ? ranker.cosineSimilarity(
              vectors[row.question],
              vectors[message.content],
            )
          : undefined,
      )
    : undefined;
  const recalled = ranker.rankRecalledMessages({
    question: row.question,
    candidates,
    semantic,
    options,
  });
  // A hit is the exact message that holds the fact, not any message that happens to repeat a word of it.
  const isGold = (message) => message.content === row.gold;
  const holds = (list) => list.some(isGold);
  const gold = isGold;
  return {
    inWindow: holds(recent),
    recalledHit: holds(recalled),
    recalledCount: recalled.length,
    noise: recalled.filter((message) => !gold(message)).length,
  };
}

function evaluate(options) {
  const groups = {};
  for (const row of dataset) {
    const result = run(row, options);
    const key =
      row.kind === 'negative'
        ? 'negative'
        : row.distance <= 11
          ? 'inside window'
          : row.distance >= 100
            ? 'out of reach'
            : 'recall needed';
    const group = (groups[key] ??= {
      n: 0,
      hit: 0,
      recalled: 0,
      noise: 0,
      byKind: {},
      byDistance: {},
    });
    const hit =
      row.kind === 'negative'
        ? result.recalledCount === 0
        : result.inWindow || result.recalledHit;
    group.n += 1;
    group.hit += hit ? 1 : 0;
    group.recalled += result.recalledCount;
    group.noise += result.noise;
    for (const [bucket, name] of [
      [group.byKind, row.kind],
      [group.byDistance, row.distance],
    ]) {
      const cell = (bucket[name] ??= { n: 0, hit: 0 });
      cell.n += 1;
      cell.hit += hit ? 1 : 0;
    }
  }
  return groups;
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '-');

if (args.includes('--sweep')) {
  const rows = [];
  for (const minSemantic of [0.45, 0.5, 0.55, 0.6]) {
    for (const minLexical of [0.5, 0.67, 1.1]) {
      for (const semanticWeight of [0.75, 0.9]) {
        for (const margin of [0.05, 0.1, 0.2, 1]) {
          const g = evaluate({
            minSemantic,
            minLexical,
            semanticWeight,
            margin,
          });
          const need = g['recall needed'];
          const neg = g.negative;
          rows.push({
            minSemantic,
            minLexical,
            semanticWeight,
            margin,
            recall: need.hit / need.n,
            falseRecall: 1 - neg.hit / neg.n,
            noise: need.noise / need.n,
          });
        }
      }
    }
  }
  const score = (r) => r.recall - 0.4 * r.falseRecall - 0.05 * r.noise;
  rows.sort((a, b) => score(b) - score(a));
  console.table(
    rows.slice(0, 12).map((r) => ({
      ...r,
      recall: pct(r.recall, 1),
      falseRecall: pct(r.falseRecall, 1),
      noise: r.noise.toFixed(2),
    })),
  );
  process.exit(0);
}

// How often a confident quote exists and is the right message, over the live window and the
// earlier messages together (what the answer step has available).
function quoteStats() {
  const stats = {
    positive: 0,
    quoted: 0,
    correct: 0,
    negative: 0,
    negativeQuoted: 0,
  };
  for (const row of dataset) {
    if (row.kind !== 'negative' && (row.distance < 12 || row.distance > 70))
      continue;
    const messages = row.history.slice(-(LIVE_WINDOW + OLDER_WINDOW));
    const candidates = messages.filter(
      (m) => !/^I (can only help|could not|do not have)/.test(m.content),
    );
    const embedded = new Set(ranker.selectEmbeddingCandidates(candidates, 40));
    const semantic = vectors
      ? candidates.map((m, i) =>
          embedded.has(i) && vectors[m.content] && vectors[row.question]
            ? ranker.cosineSimilarity(vectors[row.question], vectors[m.content])
            : undefined,
        )
      : undefined;
    const quote = ranker.strongRecallMatch({
      question: row.question,
      candidates,
      semantic,
    });
    if (row.kind === 'negative') {
      stats.negative += 1;
      stats.negativeQuoted += quote ? 1 : 0;
    } else {
      stats.positive += 1;
      stats.quoted += quote ? 1 : 0;
      stats.correct += quote && quote.content === row.gold ? 1 : 0;
    }
  }
  return stats;
}
if (args.includes('--quote')) {
  const q = quoteStats();
  console.log(
    `quote: positive cases ${q.positive}, a confident quote exists for ${q.quoted} (${pct(q.quoted, q.positive)}), the right one in ${q.correct} (${pct(q.correct, q.quoted)} of quotes); negatives ${q.negative}, quoted ${q.negativeQuoted} (${pct(q.negativeQuoted, q.negative)})`,
  );
  process.exit(0);
}

const options = {};
for (const key of [
  'minSemantic',
  'minLexical',
  'semanticWeight',
  'limit',
  'embedMax',
  'margin',
  'questionPenalty',
]) {
  if (flag(`--${key}`) !== undefined) options[key] = Number(flag(`--${key}`));
}
console.log(
  `ranker options: ${JSON.stringify({ ...ranker.DEFAULT_RECALL_RANKING, ...options })}  embeddings: ${vectors ? 'yes' : 'no (words only)'}`,
);
const groups = evaluate(options);
for (const [name, group] of Object.entries(groups)) {
  console.log(
    `\n${name}: ${group.hit}/${group.n} ok (${pct(group.hit, group.n)}), avg recalled ${(group.recalled / group.n).toFixed(2)}, avg noise ${(group.noise / group.n).toFixed(2)}`,
  );
  console.log(
    '  by kind     ',
    Object.entries(group.byKind)
      .map(([k, c]) => `${k} ${pct(c.hit, c.n)}`)
      .join(' | '),
  );
  if (name === 'recall needed') {
    console.log(
      '  by distance ',
      Object.entries(group.byDistance)
        .map(([k, c]) => `${k} ${pct(c.hit, c.n)}`)
        .join(' | '),
    );
  }
}
