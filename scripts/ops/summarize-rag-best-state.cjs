#!/usr/bin/env node
'use strict';
// Combines the Haiku v10 semantic scores of the paired baseline, candidate v100 and candidate v101 cohorts, plus the
// refusal next-step rejudge, into one comparison: per-dimension means over each cohort's scored cases, and
// responseRelevancy per bucket. Usage (from repo root): node scripts/ops/summarize-rag-best-state.cjs
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const run = path.join(root, '.benchmarks/gemma-qdrant-live-20261102-01');
const datasetDir = path.join(
  root,
  '.benchmarks/rag-remediation-v8-20261027-01/dataset-v8-frame-reviewed-20261027-01',
);
const DIMENSIONS = [
  'faithfulness',
  'factualCorrectness',
  'responseRelevancy',
  'contextCompleteness',
];

const readJsonl = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const byCase = (file) => new Map(readJsonl(file).map((r) => [r.caseId, r]));
const score = (record, dimension) =>
  typeof record?.scores?.[dimension]?.score === 'number'
    ? record.scores[dimension].score
    : undefined;
const mean = (values) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;

function main() {
  const paired = path.join(run, 'paired-v100-rubric-v10-20261105-01');
  const v101Dir = path.join(run, 'frozen-candidate-v101-full-20261106-01');
  const cohorts = {
    baseline: byCase(
      path.join(paired, 'cohort-v100-baseline/semantic-cases.jsonl'),
    ),
    v100: byCase(
      path.join(paired, 'cohort-v100-candidate/semantic-cases.jsonl'),
    ),
    v101: byCase(path.join(v101Dir, 'semantic-cases.jsonl')),
  };
  // The Haiku judge is noisy per case, so every rejudge run found next to the cohort is averaged per case.
  const samples = new Map();
  for (const file of fs
    .readdirSync(v101Dir)
    .filter((name) => /^refusal-nextstep-rejudge.*\.jsonl$/.test(name))) {
    for (const record of readJsonl(path.join(v101Dir, file))) {
      samples.set(record.caseId, [
        ...(samples.get(record.caseId) ?? []),
        record.next,
      ]);
    }
  }
  const refusal = new Map(
    [...samples].map(([id, values]) => [id, mean(values)]),
  );
  const withRefusal = new Map(
    [...cohorts.v101].map(([id, record]) => [
      id,
      refusal.has(id)
        ? {
            ...record,
            scores: {
              ...record.scores,
              responseRelevancy: { score: refusal.get(id) },
            },
          }
        : record,
    ]),
  );
  const all = { ...cohorts, 'v101 + refusal next step': withRefusal };
  const buckets = new Map(
    ['development', 'held_out'].flatMap((split) =>
      JSON.parse(
        fs.readFileSync(path.join(datasetDir, `${split}.json`), 'utf8'),
      ).map((row) => [row.id, row.metadata.bucket]),
    ),
  );
  const rows = [];
  for (const [name, cohort] of Object.entries(all)) {
    const result = { cohort: name };
    for (const dimension of DIMENSIONS) {
      const values = [...cohort.values()]
        .map((r) => score(r, dimension))
        .filter((v) => v !== undefined);
      result[dimension] = {
        mean: Number(mean(values).toFixed(3)),
        n: values.length,
      };
    }
    result.relevancyByBucket = {};
    for (const bucket of new Set(buckets.values())) {
      const values = [...cohort]
        .filter(([id]) => buckets.get(id) === bucket)
        .map(([, r]) => score(r, 'responseRelevancy'))
        .filter((v) => v !== undefined);
      if (values.length)
        result.relevancyByBucket[bucket] = Number(mean(values).toFixed(3));
    }
    rows.push(result);
  }
  console.log(JSON.stringify(rows, null, 1));
}

if (require.main === module) main();
