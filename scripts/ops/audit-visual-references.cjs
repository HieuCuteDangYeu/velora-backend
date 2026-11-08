#!/usr/bin/env node
'use strict';
// Audits the benchmark's VISUAL reference descriptions against the stored frames with Claude Haiku 5.5 vision.
// It reports only claims the image clearly contradicts, never details the reference omits. Read-only: it writes one
// JSONL report and changes neither the dataset nor any production data.
// Usage (from repo root): node scripts/ops/audit-visual-references.cjs <out.jsonl> [limit]
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const packetPath = path.join(
  root,
  '.benchmarks/rag-remediation-v8-20261027-01/visual-frame-review-complete-20261027-01/review-packet-v2-dataset-bound.json',
);
const framesDir = path.join(
  root,
  '.benchmarks/rag-remediation-v7-20261022-01/visual-frame-review-complete-20261027-02/frames',
);
const datasetDir = path.join(
  root,
  '.benchmarks/rag-remediation-v8-20261027-01/dataset-v8-frame-reviewed-20261027-01',
);
const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'contradictions'],
  properties: {
    verdict: { type: 'string', enum: ['CONSISTENT', 'CONTRADICTED'] },
    contradictions: { type: 'array', items: { type: 'string' } },
  },
};

function loadFrames() {
  const rows = new Map(
    ['development', 'held_out'].flatMap((split) =>
      JSON.parse(
        fs.readFileSync(path.join(datasetDir, `${split}.json`), 'utf8'),
      ).map((row) => [row.id, row]),
    ),
  );
  const packet = JSON.parse(fs.readFileSync(packetPath, 'utf8'));
  const seen = new Set();
  const frames = [];
  for (const review of packet.frameReviews) {
    const group = (review.expectedEvidenceGroups || []).flat()[0] || '';
    const match = group.match(/^reel:([0-9a-f-]+):visual:(\d+)$/);
    const row = rows.get(review.caseId);
    if (!match || !row) continue;
    const file = `${match[1]}-visual-${match[2]}.jpg`;
    if (!fs.existsSync(path.join(framesDir, file)) || seen.has(file)) continue;
    seen.add(file);
    frames.push({
      caseId: review.caseId,
      file,
      reference:
        row.expectedOutput?.referenceAnswer ??
        row.expectedOutput?.acceptedAnswers?.[0] ??
        '',
    });
  }
  return frames;
}

function audit(frame) {
  const prompt = `Open the image file at ${path.join(framesDir, frame.file)} with the Read tool. Below is a reference description of that single frame.\n\nREFERENCE:\n${frame.reference}\n\nList only statements in the reference that the image CLEARLY contradicts (a wrong count, colour, pose, action, object or on-screen text). Do not list details the reference leaves out, and do not list anything you are unsure about. Set verdict to CONTRADICTED only if at least one clear contradiction exists, otherwise CONSISTENT with an empty list. Quote the contradicting reference words and state what the image shows.`;
  const run = spawnSync(
    'claude',
    [
      '-p',
      '--model',
      'claude-haiku-5-5',
      '--tools',
      'Read',
      '--allowedTools',
      'Read',
      '--add-dir',
      framesDir,
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(schema),
      '--no-session-persistence',
      '--disable-slash-commands',
      '--setting-sources',
      '',
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TERM: 'dumb',
        NO_COLOR: '1',
      },
      input: prompt,
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  let envelope;
  try {
    envelope = JSON.parse(run.stdout);
  } catch {
    envelope = undefined;
  }
  if (run.status !== 0 || envelope?.is_error || !envelope?.structured_output)
    throw new Error(`audit failed: exit ${run.status}`);
  return envelope.structured_output;
}

function main() {
  const [outFile, limitArg] = process.argv.slice(2);
  if (!outFile)
    throw new Error('Usage: audit-visual-references <out.jsonl> [limit]');
  const done = new Set(
    fs.existsSync(outFile)
      ? fs
          .readFileSync(outFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line).caseId)
      : [],
  );
  const frames = loadFrames().slice(0, limitArg ? Number(limitArg) : undefined);
  let n = 0;
  for (const frame of frames) {
    if (done.has(frame.caseId)) continue;
    let result;
    try {
      result = audit(frame);
    } catch (error) {
      result = { verdict: 'ERROR', contradictions: [String(error.message)] };
    }
    fs.appendFileSync(
      outFile,
      `${JSON.stringify({ caseId: frame.caseId, file: frame.file, reference: frame.reference, ...result })}\n`,
    );
    n += 1;
    process.stderr.write(`\r${n}/${frames.length - done.size}`);
  }
  process.stderr.write('\n');
}

if (require.main === module) main();

module.exports = { loadFrames };
