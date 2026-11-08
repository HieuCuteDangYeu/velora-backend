#!/usr/bin/env node
'use strict';

// Paired Haiku judge over two live-benchmark state files that share a dataset.
// Usage: judge-live-paired.cjs <old.state.json> <new.state.json> <out.jsonl>
//        [--sample N] [--shard I/K] [--seed S]
// Judges factualCorrectness and responseRelevancy for the old and new answer of
// each sampled case, using the dataset reference answer. Appends one JSON line
// per case so an interrupted shard can be resumed.

const crypto = require('node:crypto');
const fs = require('node:fs');
const { buildDimensionPrompt } = require('./rag-judge-prompts.cjs');
const { runClaudeDimension } = require('./run-claude-rag-judge.cjs');

const DIMENSIONS = ['factualCorrectness', 'responseRelevancy'];

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith('--')) {
      options[value.slice(2)] = argv[index + 1];
      index += 1;
    } else {
      positional.push(value);
    }
  }
  return { positional, options };
}

function stableRank(seed, id) {
  return crypto.createHash('sha256').update(`${seed}:${id}`).digest('hex');
}

function judgeAnswer(item, answer) {
  const result = {};
  for (const dimension of DIMENSIONS) {
    const prompt = buildDimensionPrompt(dimension, {
      question: item.input.question,
      generatedAnswer: String(answer ?? ''),
      referenceAnswer: item.expectedOutput.answer,
      answerType: item.metadata?.answerType,
    });
    result[dimension] = runClaudeDimension(dimension, prompt).score;
  }
  return result;
}

function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const [oldPath, newPath, outPath] = positional;
  if (!oldPath || !newPath || !outPath)
    throw new Error('Usage: judge-live-paired <old> <new> <out> [options]');
  const sample = Number.parseInt(options.sample ?? '60', 10);
  const [shardIndex, shardCount] = String(options.shard ?? '0/1')
    .split('/')
    .map(Number);
  const seed = options.seed ?? 'paired-v1';
  const oldState = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
  const newState = JSON.parse(fs.readFileSync(newPath, 'utf8'));
  if (oldState.datasetFingerprint !== newState.datasetFingerprint)
    throw new Error('The two runs use different datasets');
  const items = new Map(
    newState.datasetSnapshot.map((item) => [item.id, item]),
  );
  const ids = [...items.keys()]
    .filter(
      (id) =>
        oldState.cases[id]?.status === 'COMPLETED' &&
        newState.cases[id]?.status === 'COMPLETED',
    )
    .sort((left, right) =>
      stableRank(seed, left).localeCompare(stableRank(seed, right)),
    )
    .slice(0, sample)
    .filter((_, position) => position % shardCount === shardIndex);
  const done = new Set(
    fs.existsSync(outPath)
      ? fs
          .readFileSync(outPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line).id)
      : [],
  );
  for (const id of ids) {
    if (done.has(id)) continue;
    const item = items.get(id);
    const row = {
      id,
      modality: item.input.modality,
      old: judgeAnswer(item, oldState.cases[id].output.answer),
      new: judgeAnswer(item, newState.cases[id].output.answer),
    };
    fs.appendFileSync(outPath, `${JSON.stringify(row)}\n`);
    console.log(`judged ${id}`);
  }
}

main();
