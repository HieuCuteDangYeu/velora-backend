#!/usr/bin/env node

'use strict';

// Copies Langfuse datasets and their items from one project to another
// (for example Langfuse Cloud -> the local self-hosted stack). Item IDs are
// preserved and writes are upserts, so the script is safe to re-run.
// Credentials are read from environment variables only and are never printed:
//   SOURCE_LANGFUSE_BASE_URL / SOURCE_LANGFUSE_PUBLIC_KEY / SOURCE_LANGFUSE_SECRET_KEY
//   TARGET_LANGFUSE_BASE_URL / TARGET_LANGFUSE_PUBLIC_KEY / TARGET_LANGFUSE_SECRET_KEY
// Usage: node scripts/ops/migrate-langfuse-datasets.cjs [--dry-run]

const PAGE_LIMIT = 100;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function createClient(prefix) {
  const baseUrl = requireEnv(`${prefix}_LANGFUSE_BASE_URL`).replace(/\/+$/, '');
  const authorization = `Basic ${Buffer.from(
    `${requireEnv(`${prefix}_LANGFUSE_PUBLIC_KEY`)}:${requireEnv(`${prefix}_LANGFUSE_SECRET_KEY`)}`,
  ).toString('base64')}`;
  return {
    baseUrl,
    async request(method, path, body) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          `${method} ${path} failed with ${response.status}: ${text.slice(0, 200)}`,
        );
      }
      return text ? JSON.parse(text) : null;
    },
  };
}

async function listAll(client, path) {
  const rows = [];
  for (let page = 1; ; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const result = await client.request(
      'GET',
      `${path}${separator}page=${page}&limit=${PAGE_LIMIT}`,
    );
    rows.push(...result.data);
    if (page >= (result.meta?.totalPages ?? 0)) return rows;
  }
}

// Source trace/observation IDs point at cloud traces that do not exist in the
// target project, so they are dropped rather than left dangling.
function toDatasetPayload(dataset) {
  return {
    name: dataset.name,
    description: dataset.description ?? undefined,
    metadata: dataset.metadata ?? undefined,
    inputSchema: dataset.inputSchema ?? undefined,
    expectedOutputSchema: dataset.expectedOutputSchema ?? undefined,
  };
}

function toItemPayload(item) {
  return {
    id: item.id,
    datasetName: item.datasetName,
    input: item.input ?? undefined,
    expectedOutput: item.expectedOutput ?? undefined,
    metadata: item.metadata ?? undefined,
    status: item.status,
  };
}

async function migrate({ source, target, dryRun }) {
  const datasets = await listAll(source, '/api/public/v2/datasets');
  const summary = [];
  for (const dataset of datasets) {
    const items = await listAll(
      source,
      `/api/public/dataset-items?datasetName=${encodeURIComponent(dataset.name)}`,
    );
    if (!dryRun) {
      await target.request(
        'POST',
        '/api/public/v2/datasets',
        toDatasetPayload(dataset),
      );
      for (const item of items) {
        await target.request(
          'POST',
          '/api/public/dataset-items',
          toItemPayload(item),
        );
      }
    }
    summary.push({ name: dataset.name, sourceItems: items.length });
  }
  return summary;
}

async function verify({ source, target }) {
  const mismatches = [];
  const datasets = await listAll(source, '/api/public/v2/datasets');
  for (const dataset of datasets) {
    const path = `/api/public/dataset-items?datasetName=${encodeURIComponent(dataset.name)}`;
    const [sourceItems, targetItems] = await Promise.all([
      listAll(source, path),
      listAll(target, path),
    ]);
    const targetById = new Map(targetItems.map((item) => [item.id, item]));
    const mismatched = sourceItems.filter((item) => {
      const copy = targetById.get(item.id);
      return (
        !copy ||
        JSON.stringify([copy.input, copy.expectedOutput, copy.status]) !==
          JSON.stringify([item.input, item.expectedOutput, item.status])
      );
    });
    if (mismatched.length || sourceItems.length !== targetItems.length) {
      mismatches.push({
        name: dataset.name,
        source: sourceItems.length,
        target: targetItems.length,
        mismatched: mismatched.length,
      });
    }
  }
  return mismatches;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const source = createClient('SOURCE');
  const target = createClient('TARGET');
  const summary = await migrate({ source, target, dryRun });
  const totalItems = summary.reduce((sum, row) => sum + row.sourceItems, 0);
  console.log(
    JSON.stringify({
      dryRun,
      from: source.baseUrl,
      to: target.baseUrl,
      datasets: summary.length,
      items: totalItems,
    }),
  );
  if (dryRun) return;
  const mismatches = await verify({ source, target });
  console.log(JSON.stringify({ verified: mismatches.length === 0, mismatches }));
  if (mismatches.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { toDatasetPayload, toItemPayload };
