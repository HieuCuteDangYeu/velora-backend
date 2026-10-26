#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { fingerprint } = require('./rag-evaluation-contract.cjs');

const root = path.resolve(__dirname, '../..');
const defaultDatasetDir = path.join(
  root,
  '.benchmarks/rag-remediation-v8-20261026-01/dataset-v8-source-disjoint-20261026-03',
);
const supportedDatasetVersions = new Set([
  'rag-v8-source-disjoint-20261026-03',
  'rag-v9-agent-reviewed-20261026-01',
]);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadFrozenDataset(datasetDir = defaultDatasetDir) {
  const manifest = readJson(path.join(datasetDir, 'manifest.json'));
  const items = readJson(path.join(datasetDir, 'cases.json'));
  if (
    !supportedDatasetVersions.has(manifest.datasetVersion) ||
    manifest.caseCount !== 136 ||
    manifest.datasetSha256 !== fingerprint(items) ||
    new Set(items.map((item) => item.id)).size !== items.length ||
    items.some(
      (item) =>
        ![
          'AGENT_REVIEWED_CANDIDATE',
          'AGENT_REVIEWED_CORRECTED_CANDIDATE',
        ].includes(item.metadata?.annotationStatus) ||
        item.metadata?.reviewAuthority !== 'AGENT_AUTHORIZED_SOURCE_OF_TRUTH' ||
        item.metadata?.humanApproved !== false,
    )
  ) {
    throw new Error(
      'Langfuse publication requires an approved frozen 136-case agent-reviewed dataset',
    );
  }
  if (
    manifest.datasetVersion === 'rag-v9-agent-reviewed-20261026-01' &&
    (manifest.sourceReviewSampleSize !== 44 ||
      manifest.correctedReferenceCount !== 2 ||
      manifest.humanApproved !== false)
  )
    throw new Error('V9 dataset review provenance is incomplete');
  return {
    manifest,
    items,
    datasetDir,
    datasetName: `velora/${manifest.datasetVersion}`,
  };
}

function sameItem(remote, local) {
  return Boolean(
    remote &&
    remote.id === local.id &&
    fingerprint(remote.input) === fingerprint(local.input) &&
    fingerprint(remote.expectedOutput) === fingerprint(local.expectedOutput) &&
    fingerprint(remote.metadata) === fingerprint(local.metadata),
  );
}

function selfTest(datasetDir) {
  const { manifest, items, datasetName } = loadFrozenDataset(datasetDir);
  assert.equal(items.length, 136);
  assert.equal(datasetName, `velora/${manifest.datasetVersion}`);
  if (manifest.datasetVersion === 'rag-v8-source-disjoint-20261026-03') {
    assert.equal(new Set(items.flatMap((item) => item.input.reelIds)).size, 9);
    assert.equal(manifest.v7SourceOverlap, 0);
  } else {
    assert.equal(manifest.sourceReviewSampleSize, 44);
    assert.equal(manifest.correctedReferenceCount, 2);
    assert(
      items.filter((item) => item.expectedOutput.acceptedAnswers?.length)
        .length >= 1,
    );
  }
  assert(items.some((item) => item.metadata.bucket === 'COMBINED'));
  assert(items.some((item) => item.metadata.bucket === 'MULTI_REEL'));
  assert(
    items.every(
      (item) =>
        item.input.question && Array.isArray(item.expectedOutput.evidenceIds),
    ),
  );
  process.stdout.write(
    `${manifest.datasetVersion} Langfuse publication self-check passed\n`,
  );
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value?.startsWith('--')) continue;
    const [name, inline] = value.slice(2).split('=', 2);
    const next = inline ?? argv[index + 1];
    if (inline === undefined && next && !next.startsWith('--')) index += 1;
    args[name] = inline ?? next ?? true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const datasetDir = path.resolve(args['dataset-dir'] || defaultDatasetDir);
  if (args['self-test']) return selfTest(datasetDir);
  if (!args.apply) throw new Error('Langfuse dataset writes require --apply');
  const { manifest, items, datasetName } = loadFrozenDataset(datasetDir);
  dotenv.config({ path: path.join(root, '.env') });
  for (const name of [
    'LANGFUSE_PUBLIC_KEY',
    'LANGFUSE_SECRET_KEY',
    'LANGFUSE_BASE_URL',
  ])
    if (!process.env[name])
      throw new Error(`Missing ${name} for Langfuse publication`);

  const { LangfuseClient } = require('@langfuse/client');
  const client = new LangfuseClient({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL,
  });
  try {
    let dataset;
    try {
      dataset = await client.dataset.get(datasetName, {
        fetchItemsPageSize: 100,
      });
    } catch (error) {
      if ((error?.status ?? error?.statusCode) !== 404) throw error;
    }
    if (!dataset) {
      await client.createDataset({
        name: datasetName,
        description: `${manifest.datasetVersion}: agent source-reviewed source-disjoint RAG benchmark. It is not human-approved gold.`,
        metadata: {
          ...manifest,
          annotationStatus: 'AGENT_REVIEWED_CANDIDATE',
          humanApproved: false,
        },
        inputSchema: {
          type: 'object',
          required: ['question', 'reelIds', 'evidenceIds'],
          properties: {
            question: { type: 'string' },
            reelIds: { type: 'array', items: { type: 'string' } },
            evidenceIds: { type: 'array', items: { type: 'string' } },
            modality: { type: 'string' },
          },
        },
      });
      dataset = await client.dataset.get(datasetName, {
        fetchItemsPageSize: 100,
      });
    }
    if (dataset.metadata?.datasetSha256 !== manifest.datasetSha256)
      throw new Error(
        'Langfuse V8 dataset name already belongs to another frozen hash',
      );

    let remoteItems = dataset.items ?? [];
    const existing = new Map(remoteItems.map((item) => [item.id, item]));
    for (const item of items) {
      if (existing.has(item.id) && !sameItem(existing.get(item.id), item))
        throw new Error(
          `Langfuse V8 item differs from frozen content: ${item.id}`,
        );
    }
    const missing = items.filter((item) => !existing.has(item.id));
    for (let start = 0; start < missing.length; start += 8) {
      const batch = missing.slice(start, start + 8);
      await Promise.all(
        batch.map((item) =>
          client.dataset.createItem({ datasetName, ...item }),
        ),
      );
      remoteItems = await client.dataset
        .get(datasetName, { fetchItemsPageSize: 100 })
        .then((value) => value.items ?? []);
      for (const item of batch) {
        const confirmed = remoteItems.find((entry) => entry.id === item.id);
        if (!sameItem(confirmed, item))
          throw new Error(
            `Langfuse did not confirm V8 item creation: ${item.id}`,
          );
        existing.set(item.id, confirmed);
      }
      process.stdout.write(
        JSON.stringify({
          status: 'READBACK_VERIFIED',
          created: Math.min(start + batch.length, missing.length),
          remaining: missing.length - start - batch.length,
        }) + '\n',
      );
    }
    const readback = await client.dataset.get(datasetName, {
      fetchItemsPageSize: 100,
    });
    const returned = readback.items ?? [];
    if (
      returned.length !== items.length ||
      new Set(returned.map((item) => item.id)).size !== items.length ||
      items.some(
        (item) =>
          !sameItem(
            returned.find((remote) => remote.id === item.id),
            item,
          ),
      )
    )
      throw new Error(
        'Langfuse V8 dataset readback does not match the frozen 136 cases',
      );
    const registration = {
      datasetName,
      datasetId: readback.id,
      projectId: readback.projectId,
      datasetSha256: manifest.datasetSha256,
      itemCount: returned.length,
      url: `${process.env.LANGFUSE_BASE_URL.replace(/\/$/, '')}/project/${readback.projectId}/datasets/${readback.id}`,
      readbackVerifiedAt: new Date().toISOString(),
    };
    const registrationPath = path.join(
      datasetDir,
      'langfuse-registration.json',
    );
    if (fs.existsSync(registrationPath)) {
      const prior = readJson(registrationPath);
      if (
        prior.datasetSha256 !== registration.datasetSha256 ||
        prior.datasetId !== registration.datasetId
      )
        throw new Error(
          'Existing Langfuse V8 registration conflicts with verified dataset',
        );
    } else {
      fs.writeFileSync(
        registrationPath,
        JSON.stringify(registration, null, 2),
        { mode: 0o600, flag: 'wx' },
      );
    }
    await client.flush();
    process.stdout.write(JSON.stringify(registration, null, 2) + '\n');
  } finally {
    await client.flush();
    await client.shutdown();
  }
}

if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

module.exports = { loadFrozenDataset, sameItem, parseArgs };
