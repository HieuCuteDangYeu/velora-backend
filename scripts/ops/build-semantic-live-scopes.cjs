'use strict';
/**
 * Writes a conversation-scope file for `semantic-live-eval.cjs run --scopes`.
 * Each REVIEWED case gets the reels of a pretend conversation: its gold reel
 * plus other reels from different series, `--foreign` of them mostly-CJK text.
 *
 *   node scripts/ops/build-semantic-live-scopes.cjs \
 *     --items .benchmarks/semantic-live-items.json \
 *     --cases eval/rag/datasets/rag-semantic-live-v1.jsonl \
 *     --size 5 --foreign 2 --seed scope-v1 --out .benchmarks/scopes-5-2.json
 *
 * The output holds reel ids only (no transcript text) but keep it under
 * `.benchmarks/` with the other artifacts.
 */
const fs = require('node:fs');
const lib = require('../../eval/rag/semantic-live-eval-lib.cjs');

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1)
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[(i += 1)];
  for (const k of ['items', 'cases', 'out'])
    if (!args[k]) throw new Error(`--${k} is required`);
  const items = JSON.parse(fs.readFileSync(args.items, 'utf8')).items;
  const cases = lib
    .parseJsonl(fs.readFileSync(args.cases, 'utf8'))
    .filter((r) => r.status === 'REVIEWED');
  const scopes = lib.buildScopes({
    items,
    cases,
    seed: args.seed ?? 'scope-v1',
    size: Number(args.size ?? 5),
    foreign: Number(args.foreign ?? 0),
    foreignSameSeries: args['same-series'] === 'true',
  });
  fs.writeFileSync(args.out, JSON.stringify(scopes, null, 2));
  process.stdout.write(
    `${JSON.stringify({ cases: cases.length, size: Number(args.size ?? 5), foreign: Number(args.foreign ?? 0) })}\n`,
  );
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
module.exports = { main };
