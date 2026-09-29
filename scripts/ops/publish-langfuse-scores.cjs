#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value?.startsWith('--')) continue;
    const [name, inlineValue] = value.slice(2).split('=', 2);
    const next = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined && next && !next.startsWith('--')) index += 1;
    args[name] = inlineValue ?? next ?? true;
  }
  return args;
}

function normalize(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function evidenceRecall(expected = [], actual = []) {
  const expectedSet = new Set(expected);
  if (!expectedSet.size) return 1;
  const matched = new Set(actual).size
    ? [...new Set(actual)].filter((id) => expectedSet.has(id)).length
    : 0;
  return matched / expectedSet.size;
}

function deterministicScores(record) {
  const expected = record.expectedOutput ?? record.reference ?? {};
  const actual = record.output ?? record.actual ?? {};
  const expectedAnswer = expected.answer ?? expected;
  const actualAnswer = actual.answer ?? actual;
  return [
    {
      name: 'deterministic_exact_match',
      value: normalize(expectedAnswer) === normalize(actualAnswer) ? 1 : 0,
    },
    {
      name: 'deterministic_evidence_recall',
      value: evidenceRecall(
        expected.evidenceIds ?? expected.relevantEvidenceIds,
        actual.evidenceIds ?? actual.citationEvidenceIds,
      ),
    },
    {
      name: 'deterministic_modality_match',
      value:
        expected.modality &&
        actual.modality &&
        expected.modality === actual.modality
          ? 1
          : 0,
    },
  ];
}

function loadRecords(inputPath) {
  const text = fs.readFileSync(path.resolve(inputPath), 'utf8').trim();
  if (!text) return [];
  if (text.startsWith('[')) return JSON.parse(text);
  return text.split(/\r?\n/).map((line) => JSON.parse(line));
}

async function publishScores(records) {
  const { LangfuseClient } = require('@langfuse/client');
  const client = new LangfuseClient({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL,
  });
  try {
    for (const record of records) {
      if (!record.traceId) continue;
      for (const score of deterministicScores(record)) {
        client.score.create({
          traceId: record.traceId,
          name: score.name,
          value: score.value,
          dataType: 'NUMERIC',
          metadata: { evaluator: 'deterministic-v1' },
        });
      }
    }
    await client.flush();
  } finally {
    await client.shutdown();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input)
    throw new Error(
      'Usage: publish-langfuse-scores --input <results.jsonl> [--publish]',
    );
  const records = loadRecords(args.input);
  const scores = records.flatMap((record) =>
    deterministicScores(record).map((score) => ({
      traceId: record.traceId ?? null,
      ...score,
    })),
  );
  if (args.publish) {
    if (
      !process.env.LANGFUSE_PUBLIC_KEY ||
      !process.env.LANGFUSE_SECRET_KEY ||
      !process.env.LANGFUSE_BASE_URL
    ) {
      throw new Error(
        'LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, and LANGFUSE_BASE_URL are required',
      );
    }
    await publishScores(records);
  }
  process.stdout.write(
    `${JSON.stringify({ records: records.length, scores: scores.length, published: Boolean(args.publish) })}\n`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  deterministicScores,
  evidenceRecall,
  loadRecords,
  normalize,
  publishScores,
};
