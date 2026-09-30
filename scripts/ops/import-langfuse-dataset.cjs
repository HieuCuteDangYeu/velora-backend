#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DATASET_NAME = 'velora/rag-scraped-v1-provisional';
const DATASET_VERSION = 'rag-scraped-v1-provisional';
const TARGET_ROWS = 220;
const HASH_PATTERN = /^[0-9a-f]{64}$/i;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVIDENCE_TYPES = new Set(['TRANSCRIPT', 'VISUAL', 'METADATA']);

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

function loadRows(inputPath) {
  const rows = fs
    .readFileSync(path.resolve(inputPath), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`invalid JSONL at line ${index + 1}: ${error.message}`);
      }
    });
  return rows;
}

function validateRows(rows) {
  const errors = [];
  if (rows.length !== TARGET_ROWS) {
    errors.push(
      `expected exactly ${TARGET_ROWS} rows, received ${rows.length}`,
    );
  }
  const ids = new Set();
  rows.forEach((row, index) => {
    const prefix = `row ${index + 1}`;
    if (!row || typeof row !== 'object') {
      errors.push(`${prefix} must be an object`);
      return;
    }
    if (typeof row.id !== 'string' || ids.has(row.id))
      errors.push(`${prefix} id must be unique`);
    ids.add(row.id);
    if (row.datasetVersion !== DATASET_VERSION)
      errors.push(`${prefix} datasetVersion mismatch`);
    if (row.metadata?.annotationStatus !== 'GENERATED_CANDIDATE') {
      errors.push(`${prefix} must remain GENERATED_CANDIDATE`);
    }
    if (
      typeof row.metadata?.annotationSource !== 'string' ||
      !row.metadata.annotationSource.trim()
    ) {
      errors.push(`${prefix} annotationSource is required`);
    }
    if (
      !Array.isArray(row.expectedReelIds) ||
      row.expectedReelIds.length !== 1
    ) {
      errors.push(`${prefix} must have exactly one expected Reel ID`);
    } else if (!UUID_PATTERN.test(row.expectedReelIds[0])) {
      errors.push(`${prefix} expected Reel ID must be a UUID`);
    }
    if (
      !Array.isArray(row.relevantEvidenceIds) ||
      row.relevantEvidenceIds.length < 1
    ) {
      errors.push(`${prefix} must have evidence IDs`);
    }
    if (
      !Array.isArray(row.expectedEvidenceTypes) ||
      row.expectedEvidenceTypes.length !== 1 ||
      !EVIDENCE_TYPES.has(row.expectedEvidenceTypes[0])
    ) {
      errors.push(`${prefix} must have one supported modality`);
    }
    for (const key of ['sourceContentSha256', 'indexSnapshotSha256']) {
      if (!HASH_PATTERN.test(row.metadata?.[key] ?? ''))
        errors.push(`${prefix} ${key} missing or invalid`);
    }
  });
  if (errors.length) throw new Error(errors.join('; '));
  return rows;
}

function toDatasetItem(row, { datasetName = DATASET_NAME } = {}) {
  const reelId = row.expectedReelIds[0];
  const modality = row.expectedEvidenceTypes[0];
  const evidenceIds = [...row.relevantEvidenceIds];
  return {
    datasetName,
    id: row.id,
    input: {
      question: row.question,
      reelIds: [reelId],
      evidenceIds,
      modality,
    },
    expectedOutput: {
      answer: row.referenceAnswer,
      reelIds: [reelId],
      evidenceIds,
      modality,
    },
    metadata: {
      datasetVersion: row.datasetVersion,
      annotationStatus: row.metadata.annotationStatus,
      reelId,
      evidenceIds,
      modality,
      seriesId: row.metadata.seriesId ?? null,
      sourceContentSha256: row.metadata.sourceContentSha256,
      indexSnapshotSha256: row.metadata.indexSnapshotSha256,
      provenance: row.metadata.annotationSource,
    },
  };
}

function isDatasetNotFoundError(error) {
  return error?.status === 404 || error?.statusCode === 404;
}

async function ensureDataset(client, name) {
  try {
    await client.dataset.get(name, { fetchItemsPageSize: 1 });
  } catch (error) {
    if (!isDatasetNotFoundError(error)) throw error;
    await client.api.datasets.create({
      datasetName: name,
      description:
        'Deterministic provisional Reel candidates; no production RAG calls.',
      metadata: {
        datasetVersion: DATASET_VERSION,
        status: 'GENERATED_CANDIDATE',
      },
    });
  }
}

async function importRows(rows, { datasetName = DATASET_NAME } = {}) {
  const { LangfuseClient } = require('@langfuse/client');
  const client = new LangfuseClient({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL,
  });
  try {
    await ensureDataset(client, datasetName);
    for (const row of rows)
      await client.dataset.createItem(toDatasetItem(row, { datasetName }));
    await client.flush();
  } finally {
    await client.shutdown();
  }
  return { datasetName, rows: rows.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input)
    throw new Error(
      'Usage: import-langfuse-dataset --input <220-row.jsonl> [--dry-run]',
    );
  const rows = validateRows(loadRows(args.input));
  if (args['dry-run']) {
    process.stdout.write(
      `${JSON.stringify({ datasetName: DATASET_NAME, rows: rows.length, dryRun: true })}\n`,
    );
    return;
  }
  if (
    !process.env.LANGFUSE_PUBLIC_KEY ||
    !process.env.LANGFUSE_SECRET_KEY ||
    !process.env.LANGFUSE_BASE_URL
  ) {
    throw new Error(
      'LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, and LANGFUSE_BASE_URL are required',
    );
  }
  process.stdout.write(`${JSON.stringify(await importRows(rows))}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DATASET_NAME,
  DATASET_VERSION,
  TARGET_ROWS,
  importRows,
  isDatasetNotFoundError,
  loadRows,
  toDatasetItem,
  validateRows,
};
