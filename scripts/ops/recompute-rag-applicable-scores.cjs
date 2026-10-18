'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { applicability, DIMENSIONS } = require('./rag-evaluation-applicability.cjs');

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function recompute({ datasetDir, runDir, outputPath }) {
  const rows = ['development', 'held_out'].flatMap((split) =>
    JSON.parse(fs.readFileSync(path.join(datasetDir, `${split}.json`))),
  );
  const cases = new Map(rows.map((row) => [row.id, row]));
  const semanticRows = fs
    .readFileSync(path.join(runDir, 'semantic-cases.jsonl'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const metrics = Object.fromEntries(
    DIMENSIONS.map((dimension) => {
      const values = semanticRows
        .filter((entry) => {
          const row = cases.get(entry.caseId);
          return row && applicability(row)[dimension] && typeof entry.scores?.[dimension]?.score === 'number';
        })
        .map((entry) => entry.scores[dimension].score);
      return [dimension, { mean: mean(values), scored: values.length }];
    }),
  );
  const excluded = Object.fromEntries(
    DIMENSIONS.map((dimension) => [
      dimension,
      semanticRows.filter((entry) => {
        const row = cases.get(entry.caseId);
        return row && !applicability(row)[dimension];
      }).length,
    ]),
  );
  const result = {
    runDir,
    totalRows: semanticRows.length,
    metrics,
    excludedByApplicability: excluded,
    note: 'Applicable dimensions are separated from unavailable provider scores and workflow failures.',
  };
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), { mode: 0o600 });
  return result;
}

if (require.main === module) {
  const [datasetDir, runDir, outputPath] = process.argv.slice(2);
  if (!datasetDir || !runDir || !outputPath) {
    throw new Error('Usage: recompute-rag-applicable-scores <dataset-dir> <run-dir> <output.json>');
  }
  console.log(JSON.stringify(recompute({ datasetDir, runDir, outputPath }), null, 2));
}

module.exports = { recompute };
