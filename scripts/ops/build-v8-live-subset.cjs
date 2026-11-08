#!/usr/bin/env node
'use strict';

// Publishes a reel-bound subset of the frozen v8 coverage dataset to Langfuse in the input shape that
// run-langfuse-live-benchmark.cjs expects, so those cases can be run against the live backend.
// Usage: build-v8-live-subset.cjs <dataset-name> [--dry-run]
// Selected: every VISUAL case (both splits) plus TRANSCRIPT and COMBINED cases of the held-out split.

const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config();

const datasetDir = path.resolve(
  __dirname,
  '../../.benchmarks/rag-remediation-v8-20261027-01/dataset-v8-frame-reviewed-20261027-01',
);

function selectCases() {
  const selected = [];
  for (const split of ['development', 'held_out']) {
    const rows = JSON.parse(
      fs.readFileSync(path.join(datasetDir, `${split}.json`), 'utf8'),
    );
    for (const row of rows) {
      const bucket = row.metadata.bucket;
      const keep =
        bucket === 'VISUAL' ||
        (split === 'held_out' && ['TRANSCRIPT', 'COMBINED'].includes(bucket));
      if (!keep) continue;
      const evidenceIds = row.expectedOutput.relevantEvidenceIds ?? [];
      const reelIds = [
        ...new Set(
          evidenceIds
            .map((id) => /^reel:([0-9a-f-]{36}):/.exec(id)?.[1])
            .filter(Boolean),
        ),
      ];
      if (reelIds.length !== 1) continue;
      selected.push({
        id: row.id,
        input: {
          reelIds,
          modality: bucket === 'COMBINED' ? 'COMBINED' : bucket,
          question: row.input.question,
          evidenceIds,
        },
        expectedOutput: {
          answer: row.expectedOutput.referenceAnswer,
          reelIds,
          modality: bucket === 'COMBINED' ? 'COMBINED' : bucket,
          evidenceIds,
        },
        metadata: {
          bucket,
          split,
          expectedEvidenceTypes: row.expectedOutput.expectedEvidenceTypes,
          assertions: row.expectedOutput.assertions,
          datasetVersion: row.metadata.datasetVersion,
        },
      });
    }
  }
  return selected.sort((left, right) => left.id.localeCompare(right.id));
}

async function post(pathname, body) {
  const auth = Buffer.from(
    `${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`,
  ).toString('base64');
  const response = await fetch(`${process.env.LANGFUSE_BASE_URL}${pathname}`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${auth}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`${pathname} failed with ${response.status}`);
}

async function main() {
  const datasetName = process.argv[2];
  if (!datasetName)
    throw new Error('Usage: build-v8-live-subset <dataset-name>');
  const items = selectCases();
  const counts = {};
  for (const item of items)
    counts[item.metadata.bucket] = (counts[item.metadata.bucket] ?? 0) + 1;
  console.log(JSON.stringify({ datasetName, items: items.length, counts }));
  if (process.argv.includes('--dry-run')) return;
  await post('/api/public/v2/datasets', {
    name: datasetName,
    description:
      'Reel-bound subset of the frozen v8 coverage dataset for live runs',
    metadata: { source: 'rag-coverage-v8-frame-reviewed-20261027-01' },
  });
  for (const item of items)
    await post('/api/public/dataset-items', { datasetName, ...item });
  console.log('published');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
