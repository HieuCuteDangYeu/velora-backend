#!/usr/bin/env node
'use strict';

// Judges the same v8 cases twice with the shared Haiku prompt builder: the answer from a live-benchmark run and the
// answer from a frozen replay cohort. Usage:
//   judge-live-vs-replay.cjs <live.state.json> <replay-responses.jsonl> <dataset-dir> <out.jsonl> [--shard I/K]

const fs = require('node:fs');
const path = require('node:path');
const { buildDimensionPrompt } = require('./rag-judge-prompts.cjs');
const { runClaudeDimension } = require('./run-claude-rag-judge.cjs');

const DIMENSIONS = ['factualCorrectness', 'responseRelevancy'];

function judge(row, answer) {
  const scores = {};
  for (const dimension of DIMENSIONS) {
    scores[dimension] = runClaudeDimension(
      dimension,
      buildDimensionPrompt(dimension, {
        question: row.input.question,
        generatedAnswer: String(answer ?? ''),
        referenceAnswer: row.expectedOutput.referenceAnswer,
        answerType: row.metadata.answerType,
        policyAssertions: row.expectedOutput.assertions,
        expectedEvidenceTypes: row.expectedOutput.expectedEvidenceTypes,
      }),
    ).score;
  }
  return scores;
}

function main() {
  const args = process.argv.slice(2);
  const shardFlag = args.indexOf('--shard');
  const [shardIndex, shardCount] = (
    shardFlag >= 0 ? args[shardFlag + 1] : '0/1'
  )
    .split('/')
    .map(Number);
  const [livePath, replayPath, datasetDir, outPath] = args;
  const live = JSON.parse(fs.readFileSync(livePath, 'utf8'));
  const replay = new Map(
    fs
      .readFileSync(replayPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .map((record) => [record.caseId, record]),
  );
  const rows = new Map();
  for (const split of ['development', 'held_out'])
    for (const row of JSON.parse(
      fs.readFileSync(path.join(datasetDir, `${split}.json`), 'utf8'),
    ))
      rows.set(row.id, row);
  const done = new Set(
    fs.existsSync(outPath)
      ? fs
          .readFileSync(outPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line).id)
      : [],
  );
  const ids = Object.keys(live.cases)
    .filter((id) => live.cases[id].status === 'COMPLETED' && replay.has(id))
    .sort()
    .filter((_, position) => position % shardCount === shardIndex);
  for (const id of ids) {
    if (done.has(id)) continue;
    const row = rows.get(id);
    fs.appendFileSync(
      outPath,
      `${JSON.stringify({
        id,
        bucket: row.metadata.bucket,
        split: row.metadata.split,
        live: judge(row, live.cases[id].output.answer),
        replay: judge(row, replay.get(id).output.answer),
      })}\n`,
    );
    console.log(`judged ${id}`);
  }
}

main();
