#!/usr/bin/env node
'use strict';

// Offline, immutable replay. No Langfuse, database, or model calls.
const fs = require('node:fs');
const { toDatasetItem } = require('./import-langfuse-dataset.cjs');
const {
  deterministicEvaluations,
} = require('./run-langfuse-live-benchmark.cjs');
const {
  EVALUATOR_VERSION,
  fingerprint,
  strictEvaluations,
  attachTrace,
  verifyDataset,
} = require('./rag-evaluation-contract.cjs');

function analyze(state, items, traces = []) {
  verifyDataset(state, items);
  const byConversation = new Map();
  for (const trace of traces) {
    const list = byConversation.get(trace.conversationId) ?? [];
    list.push(trace);
    byConversation.set(trace.conversationId, list);
  }
  const cases = {};
  const scores = new Map();
  for (const item of items) {
    const saved = state.cases[item.id];
    if (!saved || saved.status !== 'COMPLETED') continue;
    const matches = byConversation.get(saved.conversationId) ?? [];
    if (matches.length > 1)
      throw new Error(`Ambiguous trace identity for ${item.id}`);
    const output = matches.length
      ? attachTrace(saved.output, matches[0], saved.conversationId)
      : saved.output;
    const legacy = deterministicEvaluations(
      item.input,
      item.expectedOutput,
      output,
    ).map((score) =>
      score.name === 'evidence_recall'
        ? { ...score, name: 'reel_evidence_proxy_recall' }
        : score,
    );
    const evaluations = [
      ...legacy,
      ...strictEvaluations(item.input, item.expectedOutput, output),
    ];
    cases[item.id] = {
      metrics: Object.fromEntries(
        evaluations.map((score) => [score.name, score.value]),
      ),
      retrievalAvailable: Array.isArray(output.retrievedEvidenceIds),
      generationContextAvailable: Array.isArray(output.generationEvidence),
      traceId: output.traceId,
    };
    for (const score of evaluations) {
      const values = scores.get(score.name) ?? [];
      values.push(score.value);
      scores.set(score.name, values);
    }
  }
  return {
    schemaVersion: EVALUATOR_VERSION,
    runId: state.runId,
    datasetFingerprint: fingerprint(items),
    cases,
    metrics: Object.fromEntries(
      [...scores].map(([name, values]) => [
        name,
        {
          mean: values.reduce((a, b) => a + b, 0) / values.length,
          count: values.length,
        },
      ]),
    ),
    coverage: {
      completedCases: Object.keys(cases).length,
      retrievalCases: Object.values(cases).filter((c) => c.retrievalAvailable)
        .length,
      generationContextCases: Object.values(cases).filter(
        (c) => c.generationContextAvailable,
      ).length,
    },
  };
}

function main() {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i < 0 ? undefined : process.argv[i + 1];
  };
  if (!arg('--state') || !arg('--dataset') || !arg('--output'))
    throw new Error(
      'Usage: analyze-rag-benchmark --state state.json --dataset dataset.jsonl --output new-report.json [--traces traces.jsonl] [--review new-review.json]',
    );
  const state = JSON.parse(fs.readFileSync(arg('--state'), 'utf8'));
  const rows = fs
    .readFileSync(arg('--dataset'), 'utf8')
    .trim()
    .split(/\r?\n/)
    .map(JSON.parse);
  const items = rows
    .map((row) => toDatasetItem(row))
    .map(({ id, input, expectedOutput, metadata }) => ({
      id,
      input,
      expectedOutput,
      metadata,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const traces = arg('--traces')
    ? fs
        .readFileSync(arg('--traces'), 'utf8')
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map(JSON.parse)
    : [];
  const report = analyze(state, items, traces);
  fs.writeFileSync(arg('--output'), `${JSON.stringify(report, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  if (arg('--review'))
    fs.writeFileSync(
      arg('--review'),
      `${JSON.stringify(
        {
          schemaVersion: 'velora-rag-human-review-v1',
          sourceRunId: state.runId,
          sourceDatasetFingerprint: report.datasetFingerprint,
          cases: rows.map((row) => ({
            caseId: row.id,
            question: row.question,
            candidateReference: row.referenceAnswer,
            reelIds: row.expectedReelIds,
            modality: row.expectedEvidenceTypes[0],
            evidenceIds: row.relevantEvidenceIds,
            reviewStatus: 'PENDING',
            acceptedAnswers: [],
            reviewer: null,
          })),
        },
        null,
        2,
      )}\n`,
      { flag: 'wx', mode: 0o600 },
    );
  if (arg('--enriched-state')) {
    const enriched = {
      ...state,
      datasetSnapshot: items,
      snapshotFingerprint: fingerprint(items),
      evaluatorVersion: EVALUATOR_VERSION,
      cases: { ...state.cases },
    };
    for (const [caseId, saved] of Object.entries(state.cases)) {
      if (saved.status !== 'COMPLETED') continue;
      const matches = traces.filter(
        (trace) => trace.conversationId === saved.conversationId,
      );
      if (matches.length > 1)
        throw new Error(`Ambiguous trace identity for ${caseId}`);
      enriched.cases[caseId] = {
        ...saved,
        output: matches.length
          ? attachTrace(saved.output, matches[0], saved.conversationId)
          : saved.output,
      };
    }
    fs.writeFileSync(
      arg('--enriched-state'),
      `${JSON.stringify(enriched, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
  }
  console.log(JSON.stringify(report.coverage));
}
if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { analyze };
