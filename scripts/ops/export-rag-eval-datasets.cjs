#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const datasetDirectory = path.join(root, 'eval/rag/datasets');

function load(name) {
  const file = path.join(datasetDirectory, `${name}.jsonl`);
  const rows = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (rows.some((row) => row.datasetVersion !== name))
    throw new Error(`${name} contains a mismatched datasetVersion`);
  return rows;
}

const frozen = load('rag-frozen-ami-v1');
const frozenV2 = load('rag-frozen-ami-v2');
const frozenV3 = load('rag-frozen-ami-v3');
const generalization = load('rag-generalization-v1');
const groupCount = (name) =>
  generalization.filter((row) => row.fixtureGroup === name).length;

if (
  frozen.length !== 8 ||
  frozenV2.length !== 8 ||
  frozenV3.length !== 8 ||
  generalization.length !== 104 ||
  groupCount('router') !== 65 ||
  groupCount('sufficiency') !== 20 ||
  groupCount('verifier') !== 15
) {
  throw new Error(
    'versioned Ragas dataset counts do not match the frozen contract',
  );
}

console.log(
  JSON.stringify({
    frozen: frozen.length,
    frozenV2: frozenV2.length,
    frozenV3: frozenV3.length,
    generalization: generalization.length,
    router: groupCount('router'),
    sufficiency: groupCount('sufficiency'),
    verifier: groupCount('verifier'),
  }),
);
