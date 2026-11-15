#!/usr/bin/env node
'use strict';
/**
 * Grows `eval/rag/datasets/rag-semantic-live-v1.jsonl` from a live index
 * snapshot (see `export-semantic-live-items.cjs`).
 *
 *   # append up to 100 new CANDIDATE questions (Haiku via the claude CLI)
 *   node scripts/ops/build-semantic-live-cases.cjs generate \
 *     --items .benchmarks/semantic-live-items.json \
 *     --dataset eval/rag/datasets/rag-semantic-live-v1.jsonl \
 *     --total 100 [--fresh-after 2026-11-12T00:00:00Z] [--seed 1] [--split-seed v1] [--heldout-percent 40]
 *
 *   # flag cases whose gold chunk is gone or whose text changed, restore ones that came back
 *   node scripts/ops/build-semantic-live-cases.cjs check-stale --items ... --dataset ...
 *
 *   # one-off: add the text fingerprint to rows written without one, from the
 *   # snapshot they were generated from
 *   node scripts/ops/build-semantic-live-cases.cjs backfill-hashes --items ... --dataset ...
 *
 *   # validate the dataset file
 *   node scripts/ops/build-semantic-live-cases.cjs validate --dataset ...
 *
 * `generate` never edits an existing row; it only appends, skips questions that
 * are already present and keeps every series in one split. New rows are
 * CANDIDATE until `review-semantic-live-cases.cjs apply` marks them REVIEWED.
 * Use a different `--seed` per run, otherwise the same chunks are sampled. The split of a
 * series is fixed by `--split-seed` on its first appearance and never changes afterwards.
 */
const fs = require('node:fs');
const lib = require('../../eval/rag/semantic-live-eval-lib.cjs');

const DEFAULT_DATASET = 'eval/rag/datasets/rag-semantic-live-v1.jsonl';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) {
      args._.push(argv[i]);
      continue;
    }
    const [name, inline] = argv[i].slice(2).split('=', 2);
    const next = argv[i + 1];
    if (inline !== undefined) args[name] = inline;
    else if (next && !next.startsWith('--')) {
      args[name] = next;
      i += 1;
    } else args[name] = true;
  }
  return args;
}

const readRows = (file) =>
  fs.existsSync(file) ? lib.parseJsonl(fs.readFileSync(file, 'utf8')) : [];

function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

const QUESTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['question'],
  properties: { question: { type: 'string' } },
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const dataset = args.dataset || DEFAULT_DATASET;

  if (command === 'validate') {
    const rows = readRows(dataset);
    const errors = lib.validateDataset(rows);
    if (errors.length) {
      console.error(errors.join('\n'));
      process.exit(1);
    }
    const count = (key) =>
      rows.reduce((m, r) => ({ ...m, [r[key]]: (m[r[key]] ?? 0) + 1 }), {});
    console.log(
      JSON.stringify({
        rows: rows.length,
        status: count('status'),
        split: count('split'),
        source: count('source'),
        language: count('language'),
      }),
    );
    return;
  }

  if (!args.items) throw new Error('--items <snapshot.json> is required');
  const { items } = JSON.parse(fs.readFileSync(args.items, 'utf8'));
  if (!Array.isArray(items) || !items.length)
    throw new Error('snapshot has no items');
  const existing = readRows(dataset);

  if (command === 'check-stale') {
    // id -> text fingerprint, so a re-chunked reel is caught, not only a deleted one
    const next = lib.markStale(
      existing,
      new Map(items.map((i) => [i.id, lib.textHash(i.text)])),
    );
    const changed = next.filter((r, i) => r.status !== existing[i].status);
    writeAtomic(dataset, lib.toJsonl(next));
    console.log(
      JSON.stringify({
        checked: existing.length,
        changed: changed.length,
        stale: next.filter((r) => r.status === 'STALE').length,
        staleChanged: next.filter((r) => r.staleReason === 'changed').length,
        withoutHash: next.filter((r) =>
          r.relevant.some((x) => x.grade === 2 && !x.textHash),
        ).length,
      }),
    );
    return;
  }

  if (command === 'backfill-hashes') {
    // One-off for rows written before textHash existed. Use the snapshot the
    // rows were generated from; a different snapshot would bake in new text.
    const byId = new Map(items.map((i) => [i.id, i.text]));
    let filled = 0;
    const next = existing.map((r) => ({
      ...r,
      relevant: r.relevant.map((x) => {
        if (x.textHash) return x;
        if (!byId.has(x.evidenceId))
          throw new Error(`${r.id}: ${x.evidenceId} is not in the snapshot`);
        filled += 1;
        return { ...x, textHash: lib.textHash(byId.get(x.evidenceId)) };
      }),
    }));
    const errors = lib.validateDataset(
      next.filter((r) => r.status !== 'REJECTED'),
    );
    if (errors.length) throw new Error(errors.slice(0, 10).join('\n'));
    writeAtomic(dataset, lib.toJsonl(next));
    console.log(JSON.stringify({ filled, rows: next.length }));
    return;
  }

  if (command === 'generate') {
    const { rows, stats } = await lib.buildCandidateRows({
      items,
      existingQuestions: existing.map((r) => r.question),
      askFn: async (prompt) => lib.claudeJson(prompt, QUESTION_SCHEMA).question,
      seed: Number(args.seed ?? 12345),
      total: Number(args.total ?? 100),
      perSeriesMax: Number(args['per-series-max'] ?? 6),
      viShare: Number(args['vi-share'] ?? 0.2),
      freshAfter: args['fresh-after'],
      splitSeed: String(args['split-seed'] ?? 'v1'),
      heldoutPercent: Number(args['heldout-percent'] ?? 40),
      generator: 'claude-haiku-5-5',
    });
    // A series already in the dataset keeps its split, whatever the hash says.
    const splitOf = new Map(existing.map((r) => [r.seriesId, r.split]));
    const placed = rows.map((r) =>
      splitOf.has(r.seriesId) ? { ...r, split: splitOf.get(r.seriesId) } : r,
    );
    const merged = [...existing, ...placed];
    const errors = lib.validateDataset(merged);
    if (errors.length)
      throw new Error(
        `refusing to write an invalid dataset:\n${errors.slice(0, 10).join('\n')}`,
      );
    writeAtomic(dataset, lib.toJsonl(merged));
    console.log(
      JSON.stringify({ added: placed.length, total: merged.length, ...stats }),
    );
    return;
  }

  throw new Error(
    'usage: build-semantic-live-cases.cjs generate|check-stale|backfill-hashes|validate [options]',
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
