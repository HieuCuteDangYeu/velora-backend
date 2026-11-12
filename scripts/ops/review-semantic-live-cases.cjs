#!/usr/bin/env node
'use strict';
/**
 * Human review of `rag-semantic-live-v1.jsonl`. Only REVIEWED rows count in a
 * run, so this is what turns generated candidates into evidence.
 *
 *   # 1. (optional) Haiku proposes OTHER chunks that also answer a question,
 *   #    using the top hits of a run. Proposals never change `relevant`.
 *   node scripts/ops/review-semantic-live-cases.cjs propose \
 *     --dataset eval/rag/datasets/rag-semantic-live-v1.jsonl \
 *     --items .benchmarks/semantic-live-items.json --run .benchmarks/semantic-live-run-a.json [--top-k 3]
 *
 *   # 2. Write a CSV sheet of rows still waiting for review.
 *   node scripts/ops/review-semantic-live-cases.cjs sheet --dataset ... \
 *     --items ... --out .benchmarks/semantic-live-review.csv
 *
 *   # 3. Reviewer fills `verdict` (ACCEPT | REJECT | blank = skip) and,
 *   #    when the proposed extra chunks are right, `acceptProposals` = Y.
 *   node scripts/ops/review-semantic-live-cases.cjs apply --dataset ... \
 *     --sheet .benchmarks/semantic-live-review.csv --reviewer <id> [--reviewed-at <iso>]
 *
 * The sheet holds transcript text: keep it under .benchmarks/, never commit it.
 * `apply` touches only CANDIDATE rows named in the sheet and refuses a sheet
 * whose gold chunk differs from the dataset (a stale or edited sheet).
 */
const fs = require('node:fs');
const lib = require('../../eval/rag/semantic-live-eval-lib.cjs');

const COLUMNS = [
  'caseId',
  'split',
  'language',
  'question',
  'goldEvidenceId',
  'goldText',
  'proposals',
  'proposalText',
  'verdict',
  'acceptProposals',
  'notes',
];

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const toCsv = (rows) =>
  [COLUMNS, ...rows.map((r) => COLUMNS.map((c) => r[c]))]
    .map((r) => r.map(csvCell).join(','))
    .join('\r\n') + '\r\n';

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.some((c) => c !== ''));
  if (!header || COLUMNS.some((c, i) => header[i] !== c))
    throw new Error(`sheet header must be: ${COLUMNS.join(',')}`);
  // Data past the last column means the file was re-saved with another
  // separator (for example ';' split a cell), which shifts values into the
  // wrong columns. Refuse it instead of reading shifted verdicts.
  const shifted = body.findIndex((r) =>
    r.slice(COLUMNS.length).some((c) => c.trim() !== ''),
  );
  if (shifted >= 0)
    throw new Error(
      `sheet row ${shifted + 2} has data past the last column: the file was probably re-saved with ';' or another extra separator. Open it with only the comma ticked as separator and the double quote (") as text delimiter, then fill verdict again`,
    );
  return body.map((r) =>
    Object.fromEntries(COLUMNS.map((c, i) => [c, r[i] ?? ''])),
  );
}

const proposalText = (proposals) =>
  (proposals ?? []).map((p) => `${p.evidenceId}|${p.grade}`).join('\n');

function buildSheet(rows, textById) {
  return rows
    .filter((r) => r.status === 'CANDIDATE')
    .map((r) => {
      const gold = r.relevant.find((x) => x.grade === 2);
      return {
        caseId: r.id,
        split: r.split,
        language: r.language,
        question: r.question,
        goldEvidenceId: gold.evidenceId,
        goldText:
          textById.get(gold.evidenceId) ?? '(chunk missing from snapshot)',
        proposals: proposalText(r.proposedRelevant),
        // Text of each suggested chunk so the reviewer can judge it without a lookup.
        proposalText: (r.proposedRelevant ?? [])
          .map(
            (p, i) =>
              `[${i + 1}] (grade ${p.grade}) ${(textById.get(p.evidenceId) ?? '(chunk missing from snapshot)').slice(0, 600)}`,
          )
          .join('\n\n'),
        verdict: '',
        acceptProposals: '',
        notes: '',
      };
    });
}

function applySheet(rows, sheet, { reviewerId, reviewedAt }) {
  if (!reviewerId) throw new Error('--reviewer is required');
  const byId = new Map(rows.map((r) => [r.id, r]));
  const touched = new Map();
  const counts = { accepted: 0, rejected: 0, skipped: 0 };
  for (const line of sheet) {
    const row = byId.get(line.caseId);
    if (!row) throw new Error(`sheet names unknown case ${line.caseId}`);
    const verdict = line.verdict.trim().toUpperCase();
    if (!verdict) {
      counts.skipped += 1;
      continue;
    }
    if (!['ACCEPT', 'REJECT'].includes(verdict))
      throw new Error(`${line.caseId}: verdict must be ACCEPT or REJECT`);
    if (row.status !== 'CANDIDATE')
      throw new Error(
        `${line.caseId}: only CANDIDATE rows can be reviewed (is ${row.status})`,
      );
    const gold = row.relevant.find((x) => x.grade === 2);
    if (line.goldEvidenceId !== gold.evidenceId)
      throw new Error(
        `${line.caseId}: sheet gold chunk differs from the dataset; regenerate the sheet`,
      );
    let relevant = row.relevant;
    if (
      verdict === 'ACCEPT' &&
      line.acceptProposals.trim().toUpperCase() === 'Y'
    ) {
      const merged = new Map(relevant.map((x) => [x.evidenceId, x.grade]));
      for (const p of row.proposedRelevant ?? [])
        merged.set(
          p.evidenceId,
          Math.max(merged.get(p.evidenceId) ?? 0, p.grade),
        );
      relevant = [...merged].map(([evidenceId, grade]) => ({
        evidenceId,
        grade,
      }));
    }
    const { proposedRelevant, ...rest } = row;
    touched.set(row.id, {
      ...rest,
      relevant,
      status: verdict === 'ACCEPT' ? 'REVIEWED' : 'REJECTED',
      review: {
        reviewerId,
        reviewedAt,
        ...(line.notes.trim() ? { notes: line.notes.trim() } : {}),
      },
    });
    counts[verdict === 'ACCEPT' ? 'accepted' : 'rejected'] += 1;
  }
  return { rows: rows.map((r) => touched.get(r.id) ?? r), counts };
}

const PROPOSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['grade'],
  properties: { grade: { type: 'integer', enum: [0, 1, 2] } },
};

/**
 * For each CANDIDATE row, asks `askFn` whether a top hit other than the gold
 * chunk also answers the question (2 fully, 1 partly, 0 not). Haiku is noisy,
 * so the result is only a proposal for the human reviewer.
 */
async function proposeExtras(rows, { run, textById, askFn, topK = 5 }) {
  const byCase = new Map(run.perCase.map((c) => [c.id, c]));
  const out = [];
  let asked = 0;
  for (const row of rows) {
    const hit = byCase.get(row.id);
    if (row.status !== 'CANDIDATE' || !hit?.retrieval) {
      out.push(row);
      continue;
    }
    const known = new Set(row.relevant.map((x) => x.evidenceId));
    const pool = [
      ...new Set([
        ...hit.retrieval.ranked.slice(0, topK),
        ...(hit.rerank?.ranked.slice(0, topK) ?? []),
      ]),
    ].filter((id) => !known.has(id) && textById.has(id));
    const proposed = [];
    for (const id of pool) {
      asked += 1;
      const grade = await askFn(row.question, textById.get(id));
      if (grade === 1 || grade === 2) proposed.push({ evidenceId: id, grade });
    }
    out.push(proposed.length ? { ...row, proposedRelevant: proposed } : row);
  }
  return { rows: out, asked };
}

const askHaiku = async (question, passage) =>
  lib.claudeJson(
    `Question: ${question}\n\nPassage from a video transcript:\n${passage.slice(0, 1200)}\n\nGrade how well the passage answers the question on its own: 2 = fully answers it, 1 = partly answers it or is a close neighbour, 0 = does not answer it.`,
    PROPOSE_SCHEMA,
  ).grade;

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

const loadText = (file) =>
  new Map(
    JSON.parse(fs.readFileSync(file, 'utf8')).items.map((i) => [i.id, i.text]),
  );
const writeAtomic = (file, text) => {
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const dataset =
    args.dataset || 'eval/rag/datasets/rag-semantic-live-v1.jsonl';
  const rows = lib.parseJsonl(fs.readFileSync(dataset, 'utf8'));

  if (cmd === 'sheet') {
    if (!args.items || !args.out)
      throw new Error('usage: sheet --items <snapshot> --out <sheet.csv>');
    const sheet = buildSheet(rows, loadText(args.items));
    writeAtomic(args.out, toCsv(sheet));
    console.log(JSON.stringify({ rows: sheet.length, out: args.out }));
  } else if (cmd === 'apply') {
    if (!args.sheet)
      throw new Error('usage: apply --sheet <sheet.csv> --reviewer <id>');
    const { rows: next, counts } = applySheet(
      rows,
      parseCsv(fs.readFileSync(args.sheet, 'utf8')),
      {
        reviewerId: args.reviewer,
        reviewedAt: args['reviewed-at'] || new Date().toISOString(),
      },
    );
    const errors = lib.validateDataset(next);
    if (errors.length)
      throw new Error(
        `refusing to write an invalid dataset:\n${errors.slice(0, 10).join('\n')}`,
      );
    writeAtomic(dataset, lib.toJsonl(next));
    console.log(JSON.stringify(counts));
  } else if (cmd === 'propose') {
    if (!args.items || !args.run)
      throw new Error('usage: propose --items <snapshot> --run <run.json>');
    const { rows: next, asked } = await proposeExtras(rows, {
      run: JSON.parse(fs.readFileSync(args.run, 'utf8')),
      textById: loadText(args.items),
      askFn: askHaiku,
      topK: Number(args['top-k'] ?? 3),
    });
    writeAtomic(dataset, lib.toJsonl(next));
    console.log(
      JSON.stringify({
        asked,
        withProposals: next.filter((r) => r.proposedRelevant).length,
      }),
    );
  } else
    throw new Error(
      'usage: review-semantic-live-cases.cjs propose|sheet|apply [options]',
    );
}

module.exports = { applySheet, buildSheet, parseCsv, proposeExtras, toCsv };

if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
