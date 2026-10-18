'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const dotenv = require('dotenv');
const { fingerprint } = require('./rag-evaluation-contract.cjs');

async function main() {
  const [directory, cliBin, credentialEnv] = process.argv.slice(2);
  if (!directory || !cliBin || !credentialEnv) throw new Error('Usage: publish-rag-coverage-dataset <frozen-dir> <langfuse-cli-bin> <private-credential-env>');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
  const env = { ...process.env, ...dotenv.parse(fs.readFileSync(credentialEnv)) };
  env.LANGFUSE_HOST = env.LANGFUSE_BASE_URL || env.LANGFUSE_HOST;
  if (!env.LANGFUSE_HOST || !env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) throw new Error('Langfuse credentials missing');
  const registration = [];
  function cli(args) {
    const r = cp.spawnSync(process.execPath, [cliBin, 'api', ...args, '--json'], { env, encoding: 'utf8', maxBuffer: 16e6 });
    // Do not log stderr: provider diagnostics can contain credentials or data.
    if (r.status !== 0) throw new Error('Langfuse CLI operation failed: ' + args.slice(0, 2).join(' '));
    const result = JSON.parse(r.stdout);
    if (result.status >= 400) throw new Error(`Langfuse returned status ${result.status}`);
    return result.body || result;
  }
  function bodyCall(resource, body, file) {
    fs.writeFileSync(file, JSON.stringify(body), { flag: 'wx', mode: 0o600 });
    return cli([resource, 'create', '--body-file', file]);
  }
  function same(remote, local) {
    return remote.id === local.id && fingerprint(remote.input) === fingerprint(local.input) &&
      fingerprint(remote.expectedOutput) === fingerprint(local.expectedOutput) && fingerprint(remote.metadata) === fingerprint(local.metadata);
  }
  for (const split of ['development', 'held_out', 'operational']) {
    const rows = JSON.parse(fs.readFileSync(path.join(directory, split + '.json')));
    const fixtures = JSON.parse(fs.readFileSync(path.join(directory, split + '-fixtures.json')));
    for (const row of rows) if (fingerprint(fixtures[row.id]) !== row.metadata.fixtureSha256) throw new Error('Fixture changed before publication');
    const hash = fingerprint(rows);
    const datasetName = `velora/${manifest.datasetVersion}/${split}-${hash.slice(0, 12)}`;
    const publication = path.join(directory, `publication-${split}`);
    fs.mkdirSync(publication, { recursive: true, mode: 0o700 });
    const cached = path.join(publication, 'dataset.json');
    let dataset;
    if (fs.existsSync(cached)) dataset = JSON.parse(fs.readFileSync(cached));
    else {
      // GET first: never overwrite an existing immutable dataset or unknown result.
      const get = cp.spawnSync(process.execPath, [cliBin, 'api', 'datasets', 'get', datasetName, '--json'], { env, encoding: 'utf8' });
      let result; try { result = JSON.parse(get.stdout); } catch { throw new Error('Dataset lookup failed before mutation'); }
      if (result.status === 404) {
        dataset = bodyCall('datasets', { name: datasetName,
          description: 'Approved broader RAG candidate suite. Not human gold; no new benchmark result. Frozen fixtures remain restricted locally. Backend replay does not certify production retrieval or ACL enforcement.',
          metadata: { ...manifest, split, cases: rows.length, contentSha256: hash, annotationStatus: 'GENERATED_CANDIDATE', humanApproved: false },
          inputSchema: { type: 'object', required: ['question', 'fixtureRef'], additionalProperties: false,
            properties: { question: { type: 'string' }, fixtureRef: { type: 'string' } } },
        }, path.join(publication, 'dataset-body.json'));
      } else if (result.status === 200 && result.body?.metadata?.contentSha256 === hash) dataset = result.body;
      else throw new Error('Dataset identity conflict or unavailable lookup; no mutation');
      fs.writeFileSync(cached, JSON.stringify(dataset), { flag: 'wx', mode: 0o600 });
    }
    const listed = cli(['dataset-items', 'list', '--dataset-name', datasetName, '--all', '--max-items', '500']);
    const existing = new Map((listed.data || listed).map((r) => [r.id, r]));
    for (const [i, row] of rows.entries()) {
      const item = { datasetName, ...row };
      if (existing.has(row.id)) {
        if (!same(existing.get(row.id), item)) throw new Error('Published item differs; no upsert permitted');
      } else {
        const requestFile = path.join(publication, 'item-' + row.id + '.json');
        // A leftover request without readback is ambiguous; reconcile remotely above,
        // and refuse automatic resend when the server has not returned the item.
        if (fs.existsSync(requestFile)) throw new Error('Unacknowledged publication request; reconcile before resend');
        const result = bodyCall('dataset-items', item, requestFile);
        if (!same(result, item)) throw new Error('Item create response does not match frozen row');
      }
      if ((i + 1) % 25 === 0 || i + 1 === rows.length) console.log(JSON.stringify({ split, verified: i + 1, total: rows.length }));
    }
    const readback = cli(['dataset-items', 'list', '--dataset-name', datasetName, '--all', '--max-items', '500']);
    const returned = readback.data || readback;
    if (returned.length !== rows.length) throw new Error('Published count mismatch');
    const byId = new Map(returned.map((r) => [r.id, r]));
    if (rows.some((r) => !same(byId.get(r.id) || {}, r))) throw new Error('Published content fingerprint mismatch');
    fs.writeFileSync(path.join(publication, 'readback.json'), JSON.stringify(returned), { flag: 'wx', mode: 0o600 });
    const info = { datasetName, datasetId: dataset.id, projectId: dataset.projectId, cases: rows.length, contentSha256: hash,
      version: new Date().toISOString(), url: `${env.LANGFUSE_HOST.replace(/\/$/, '')}/project/${dataset.projectId}/datasets/${dataset.id}` };
    registration.push(info);
    fs.writeFileSync(path.join(directory, 'registration.json'), JSON.stringify(registration, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ split, status: 'READBACK_VERIFIED', cases: rows.length, datasetId: dataset.id }));
  }
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
