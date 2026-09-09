'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The versioned evaluation dataset is the source of truth. Contract tests
// consume the exact same generic fixtures through this compatibility view.
const datasetPath = path.resolve(
  __dirname,
  '../../eval/rag/datasets/rag-generalization-v1.jsonl',
);
const rows = fs
  .readFileSync(datasetPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const fixtures = (group) =>
  rows.filter((row) => row.fixtureGroup === group).map((row) => row.fixture);

const routerCases = fixtures('router');
const sufficiencyCases = fixtures('sufficiency');
const verifierCases = fixtures('verifier');

if (
  routerCases.length !== 65 ||
  sufficiencyCases.length !== 20 ||
  verifierCases.length !== 15
) {
  throw new Error(
    `rag-generalization-v1 fixture contract changed unexpectedly: router=${routerCases.length}, sufficiency=${sufficiencyCases.length}, verifier=${verifierCases.length}`,
  );
}

module.exports = { routerCases, sufficiencyCases, verifierCases };
