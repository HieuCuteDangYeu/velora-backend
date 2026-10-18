'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { evaluateRecommendation } = require('./rag-structured-action-evaluator.cjs');

function evaluate({ datasetDir, runDir, outputPath }) {
  const rows = ['development', 'held_out'].flatMap((split) =>
    JSON.parse(fs.readFileSync(path.join(datasetDir, `${split}.json`))),
  );
  const fixtures = Object.assign(
    {},
    ...['development', 'held_out'].map((split) =>
      JSON.parse(fs.readFileSync(path.join(datasetDir, `${split}-fixtures.json`))),
    ),
  );
  const responses = fs
    .readFileSync(path.join(runDir, 'responses.jsonl'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const byId = new Map(responses.map((response) => [response.caseId, response]));
  const cases = rows
    .filter((row) => row.metadata.expectedRecommendationAction)
    .map((row) => {
      const response = byId.get(row.id);
      return {
        caseId: row.id,
        ...evaluateRecommendation({
          row,
          fixture: fixtures[row.id],
          output: response?.output,
        }),
        executionError: response?.error?.code,
      };
    });
  const applicable = cases.filter((entry) => entry.applicable);
  const result = {
    cases: cases.length,
    applicable: applicable.length,
    passed: applicable.filter((entry) => entry.pass).length,
    failed: applicable.filter((entry) => entry.pass === false).length,
    unavailable: applicable.filter((entry) => entry.executionError).length,
    caseResults: cases,
  };
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), { mode: 0o600 });
  return result;
}

if (require.main === module) {
  const [datasetDir, runDir, outputPath] = process.argv.slice(2);
  if (!datasetDir || !runDir || !outputPath) throw new Error('Usage: evaluate-rag-structured-actions <dataset-dir> <run-dir> <output.json>');
  console.log(JSON.stringify(evaluate({ datasetDir, runDir, outputPath }), null, 2));
}

module.exports = { evaluate };
