#!/usr/bin/env node
'use strict';
// Rejudges the canned "missing evidence" refusals in a finished cohort as if they carried the next-step sentence added to
// create-no-context-answer.use-case.ts, without rerunning the pipeline (the refusals are fixed strings). Writes one JSONL
// row per affected case with the old and new responseRelevancy score, using the same judge and context as the cohort.
// Usage (from repo root): node scripts/ops/rejudge-refusal-next-step.cjs <cohort-dir> <out.jsonl>
const fs = require('node:fs');
const path = require('node:path');
const { buildDimensionPrompt } = require('./rag-judge-prompts.cjs');
const { runClaudeDimension } = require('./run-claude-rag-judge.cjs');

const root = path.resolve(__dirname, '../..');
const datasetDir = path.join(
  root,
  '.benchmarks/rag-remediation-v8-20261027-01/dataset-v8-frame-reviewed-20261027-01',
);
const NEXT_STEP = {
  'I can only search your own saved memory, and I do not have the requested detail available here.':
    ' If you tell me the detail in this chat I can work from it, or you can ask the other person directly.',
  'I cannot find the requested detail in the conversation history available here.':
    ' If you share it again, I can continue from there.',
  'The available shared Reel context does not contain enough audio evidence to identify the requested audio detail.':
    ' I can help with the other parts of this Reel that are available.',
  'The available shared Reel context does not contain enough visual evidence to identify the requested visual detail.':
    ' I can help with the other parts of this Reel that are available.',
  'The available shared Reel context does not contain enough transcript evidence to answer the requested detail.':
    ' I can help with the other parts of this Reel that are available.',
};

function readJsonl(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function judgeContext(diagnostics) {
  if (
    diagnostics?.evaluationCapture?.contextCaptured !== true ||
    !Array.isArray(diagnostics.generationEvidence)
  )
    return undefined;
  return diagnostics.generationEvidence.slice(0, 12).map((item) => ({
    sourceId: item.sourceId ?? item.evidenceId,
    title: item.title,
    evidenceType: item.evidenceType,
    startTime: item.startTime,
    endTime: item.endTime,
    evidenceText: String(item.evidenceText ?? '').slice(0, 2000),
  }));
}

function main() {
  const [cohortDir, outFile] = process.argv.slice(2);
  if (!cohortDir || !outFile)
    throw new Error(
      'Usage: rejudge-refusal-next-step <cohort-dir> <out.jsonl>',
    );
  const rows = new Map(
    ['development', 'held_out'].flatMap((split) =>
      JSON.parse(
        fs.readFileSync(path.join(datasetDir, `${split}.json`), 'utf8'),
      ).map((row) => [row.id, row]),
    ),
  );
  const semantic = new Map(
    readJsonl(path.join(cohortDir, 'semantic-cases.jsonl')).map((r) => [
      r.caseId,
      r,
    ]),
  );
  const done = new Set(
    fs.existsSync(outFile) ? readJsonl(outFile).map((r) => r.caseId) : [],
  );
  let count = 0;
  for (const response of readJsonl(path.join(cohortDir, 'responses.jsonl'))) {
    const answer = (response.output?.answer || '').trim();
    const addition = NEXT_STEP[answer];
    const previous = semantic.get(response.caseId)?.scores?.responseRelevancy
      ?.score;
    if (!addition || typeof previous !== 'number' || done.has(response.caseId))
      continue;
    const row = rows.get(response.caseId);
    const prompt = buildDimensionPrompt('responseRelevancy', {
      question: row.input.question,
      referenceAnswer: row.expectedOutput?.acceptedAnswers?.length
        ? row.expectedOutput.acceptedAnswers
        : (row.expectedOutput?.referenceAnswer ?? ''),
      generatedAnswer: answer + addition,
      context: judgeContext(response.trace?.workflowMetrics?.diagnostics),
      answerType: row.metadata?.answerType,
      policyAssertions: row.expectedOutput?.assertions,
      expectedEvidenceTypes: row.expectedOutput?.expectedEvidenceTypes,
    });
    const next = runClaudeDimension('responseRelevancy', prompt).score;
    fs.appendFileSync(
      outFile,
      `${JSON.stringify({ caseId: response.caseId, bucket: row.metadata.bucket, previous, next })}\n`,
    );
    count += 1;
    process.stderr.write(`\r${count}`);
  }
  process.stderr.write('\n');
}

if (require.main === module) main();

module.exports = { NEXT_STEP };
