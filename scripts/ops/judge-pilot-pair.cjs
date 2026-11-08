#!/usr/bin/env node
'use strict';

// Judges the same cases from two pilot output directories (baseline A, variant B) with the shared Haiku prompt
// builder, on factual correctness, response relevancy and faithfulness (citations as generation evidence).
// Usage: judge-pilot-pair.cjs <dirA> <dirB> <dataset-dir> <split> <out.jsonl> [--shard I/K]

const fs = require('node:fs');
const path = require('node:path');
const { buildDimensionPrompt } = require('./rag-judge-prompts.cjs');
const { runClaudeDimension } = require('./run-claude-rag-judge.cjs');

function judge(row, output) {
  const answer = String(output?.answer ?? '');
  const base = {
    question: row.input.question,
    generatedAnswer: answer,
    referenceAnswer: row.expectedOutput.referenceAnswer,
    answerType: row.metadata.answerType,
    policyAssertions: row.expectedOutput.assertions,
    expectedEvidenceTypes: row.expectedOutput.expectedEvidenceTypes,
    context: output?.citations ?? [],
  };
  const scores = {};
  for (const dimension of [
    'factualCorrectness',
    'responseRelevancy',
    'faithfulness',
  ])
    scores[dimension] = runClaudeDimension(
      dimension,
      buildDimensionPrompt(dimension, base),
    ).score;
  return { ...scores, chars: answer.length };
}

function main() {
  const args = process.argv.slice(2);
  const shardFlag = args.indexOf('--shard');
  const [shardIndex, shardCount] = (
    shardFlag >= 0 ? args[shardFlag + 1] : '0/1'
  )
    .split('/')
    .map(Number);
  const [dirA, dirB, datasetDir, split, outPath] = args;
  const rows = new Map(
    JSON.parse(
      fs.readFileSync(path.join(datasetDir, `${split}.json`), 'utf8'),
    ).map((row) => [row.id, row]),
  );
  const done = new Set(
    fs.existsSync(outPath)
      ? fs
          .readFileSync(outPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line).id)
      : [],
  );
  const ids = fs
    .readdirSync(dirA)
    .filter((name) => name.startsWith('rag-') && name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, ''))
    .filter((id) => fs.existsSync(path.join(dirB, `${id}.json`)))
    .sort()
    .filter((_, position) => position % shardCount === shardIndex);
  for (const id of ids) {
    if (done.has(id)) continue;
    const read = (dir) =>
      JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')).output;
    fs.appendFileSync(
      outPath,
      `${JSON.stringify({ id, a: judge(rows.get(id), read(dirA)), b: judge(rows.get(id), read(dirB)) })}\n`,
    );
    console.log(`judged ${id}`);
  }
}

main();
