'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const readline = require('node:readline');
const dotenv = require('dotenv');
const { fingerprint } = require('./rag-evaluation-contract.cjs');

async function main() {
  const [directory, output, compiledBase, runtimeEnv, mode] =
    process.argv.slice(2);
  if (!runtimeEnv)
    throw new Error(
      'Usage: run-rag-coverage-pilot <frozen-dir> <new-output-dir> <compiled-ai-src> <private-runtime-env>',
    );
  const rows = JSON.parse(
    fs.readFileSync(path.join(directory, 'development.json')),
  );
  const fixtures = JSON.parse(
    fs.readFileSync(path.join(directory, 'development-fixtures.json')),
  );
  const first = (predicate, used) =>
    rows.find((row) => !used.has(row.id) && predicate(row));
  const selected = [];
  const used = new Set();
  const take = (count, predicate) => {
    for (let index = 0; index < count; index += 1) {
      const row = first(predicate, used);
      if (!row) throw new Error(`Pilot scenario missing at index ${index}`);
      selected.push(row);
      used.add(row.id);
    }
  };
  if (mode === 'multimodal') {
    take(5, (row) => row.metadata.answerType === 'MULTIMODAL_FACTS');
  } else if (mode === 'transcript') {
    take(5, (row) => row.metadata.bucket === 'TRANSCRIPT' && row.metadata.referenceStartSec > 0);
  } else if (mode === 'remediation') {
    take(5, (row) => row.metadata.answerType === 'MULTIMODAL_FACTS');
    take(
      5,
      (row) =>
        row.metadata.bucket === 'TRANSCRIPT' &&
        row.metadata.referenceStartSec > 0,
    );
    take(
      4,
      (row) =>
        row.metadata.bucket === 'MULTI_REEL' &&
        row.metadata.answerType === 'MULTI_SOURCE_FACTS',
    );
    take(3, (row) => row.metadata.bucket === 'MEMORY');
    take(2, (row) => row.metadata.bucket === 'RECOMMENDATION');
    take(1, (row) => row.metadata.bucket === 'ACCESS');
  } else {
    take(1, (row) => row.metadata.bucket === 'METADATA');
    take(1, (row) => row.metadata.bucket === 'VISUAL');
    take(
      1,
      (row) =>
        row.metadata.sourceScope === 'CONVERSATION_MEMORY' &&
        row.metadata.memoryScenario === 'DIRECT',
    );
  }
  if (selected.some((r) => !r)) throw new Error('Pilot scenarios missing');
  fs.mkdirSync(output, { mode: 0o700 }); // Never silently reuse or replay a run.
  const stateFile = path.join(output, 'state.json');
  const state = {
    runType: 'DEVELOPMENT_SMOKE_ONLY',
    datasetSha256: fingerprint(rows),
    compiledBase,
    startedAt: new Date().toISOString(),
    cases: Object.fromEntries(
      selected.map((r) => [r.id, { status: 'PENDING', attemptCount: 0 }]),
    ),
  };
  const save = () => {
    fs.writeFileSync(stateFile + '.tmp', JSON.stringify(state, null, 2), {
      mode: 0o600,
    });
    fs.renameSync(stateFile + '.tmp', stateFile);
  };
  save();
  const env = {
    ...process.env,
    ...dotenv.parse(fs.readFileSync('.env')),
    ...dotenv.parse(fs.readFileSync(runtimeEnv)),
    RAG_COMPILED_AI_BASE: path.resolve(compiledBase),
    RAG_FROZEN_BACKEND_EMBEDDINGS: 'true',
  };
  const child = cp.spawn(
    process.execPath,
    [path.join(__dirname, 'rag-coverage-worker.cjs')],
    { env, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const log = fs.createWriteStream(path.join(output, 'worker.log'), {
    flags: 'wx',
    mode: 0o600,
  });
  child.stderr.on('data', (d) => log.write(d));
  let pending;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    log.write(line + '\n');
    if (line.startsWith('__READY__')) readyResolve();
    if (line.startsWith('__BOOT_FAILURE__'))
      readyReject(new Error('Worker boot failed; inspect restricted log'));
    if (line.startsWith('__RESULT__') && pending) {
      const p = pending;
      pending = undefined;
      p.resolve(JSON.parse(line.slice(10)));
    }
  });
  const exit = new Promise((resolve) =>
    child.on('exit', (code) => {
      readyReject(new Error('Worker exited before readiness'));
      if (pending) {
        pending.reject(
          new Error('Worker exited with in-flight case; no replay'),
        );
        pending = undefined;
      }
      resolve(code);
    }),
  );
  try {
    await ready;
    for (const row of selected) {
      const record = state.cases[row.id];
      record.status = 'IN_FLIGHT';
      record.attemptCount = 1;
      record.startedAt = new Date().toISOString();
      save();
      const promise = new Promise((resolve, reject) => {
        pending = { resolve, reject };
      });
      child.stdin.write(
        JSON.stringify({
          row: { id: row.id, input: row.input, metadata: row.metadata },
          fixture: fixtures[row.id],
        }) + '\n',
      );
      const result = await promise;
      if (result.caseId !== row.id) throw new Error('Case provenance mismatch');
      fs.writeFileSync(
        path.join(output, row.id + '.json'),
        JSON.stringify(result, null, 2),
        { flag: 'wx', mode: 0o600 },
      );
      const diagnostics = result.trace?.workflowMetrics?.diagnostics;
      record.status = result.error ? 'FAILED' : 'COMPLETED';
      record.productionExecutionId = diagnostics?.productionExecutionId;
      record.traceCaptured = !!result.trace;
      record.generationContextCaptured =
        diagnostics?.evaluationCapture?.contextCaptured;
      record.answerPresent = !!result.output?.answer;
      record.finishedAt = new Date().toISOString();
      save();
      console.log(JSON.stringify({ caseId: row.id, ...record }));
      if (result.error || !record.productionExecutionId)
        throw new Error('Pilot execution/provenance failure; no next request');
      if (
        /GROQ_KEY_POOL_EXHAUSTED|TOKENS_PER_DAY_EXHAUSTED|AUTH_OR_CONFIGURATION_FAILURE/.test(
          JSON.stringify(diagnostics),
        )
      )
        throw new Error('Provider quota/auth failure; no next request');
    }
    state.status = 'PILOT_EXECUTION_COMPLETE';
  } catch (error) {
    state.status = 'HALTED';
    state.reason = error.message;
    throw error;
  } finally {
    save();
    child.stdin.end(JSON.stringify({ stop: true }) + '\n');
    await exit;
    log.end();
  }
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
