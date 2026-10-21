'use strict';
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), readline = require('node:readline'), dotenv = require('dotenv');
const { fingerprint } = require('./rag-evaluation-contract.cjs');

function providerStatuses(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  if (Array.isArray(value)) {
    for (const item of value) providerStatuses(item, output);
    return output;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'providerStatus')) {
    output.push(value.providerStatus);
  }
  for (const child of Object.values(value)) providerStatuses(child, output);
  return output;
}

function executionHealth(response) {
  if (response.error) {
    return { status: 'FAILED', failedStages: [response.error.code || response.error.name || 'WORKFLOW_ERROR'] };
  }
  const diagnostics = response.trace?.workflowMetrics?.diagnostics || {};
  const capture = diagnostics.evaluationCapture?.contextCaptured === true;
  const statuses = providerStatuses(diagnostics);
  const degraded = !capture ||
    diagnostics.finalFailureSource && diagnostics.finalFailureSource !== 'NONE' ||
    statuses.some((status) => status === 'ERROR' || status === 'TIMEOUT' || status === 'NETWORK_ERROR' || (typeof status === 'number' && status >= 400));
  return {
    status: degraded ? 'DEGRADED' : 'AVAILABLE',
    failedStages: degraded ? ['PROVIDER_OR_CAPTURE_DEGRADED'] : [],
  };
}

function compiledRuntimeFiles(compiledBase) {
  const resolvedBase = path.resolve(compiledBase);
  const runtimeRoot = path.resolve(resolvedBase, '../../..');
  const relativeBase = path
    .relative(runtimeRoot, resolvedBase)
    .split(path.sep)
    .join('/');
  if (relativeBase !== 'apps/ai-service/src') {
    throw new Error('Compiled AI base must end in apps/ai-service/src');
  }

  const files = [];
  const visit = (directory) => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        files.push([
          path.relative(runtimeRoot, absolute).split(path.sep).join('/'),
          fs.readFileSync(absolute, 'utf8'),
        ]);
      }
    }
  };
  visit(runtimeRoot);
  if (files.length === 0) throw new Error('Compiled AI runtime has no JavaScript files');
  return files;
}

function buildFingerprint(compiledBase) {
  return fingerprint(compiledRuntimeFiles(compiledBase));
}

async function main() {
  const [directory, output, compiledBase, runtimeEnv, ledgerPath, mode] = process.argv.slice(2);
  if (!ledgerPath) throw new Error('Usage: run-rag-coverage-evaluation <frozen-dir> <run-dir> <compiled-ai-src> <private-runtime-env> <shared-usage-ledger>');
  const rows = [], fixtures = {};
  for (const split of mode === 'operational' ? ['operational'] : ['development', 'held_out']) {
    rows.push(...JSON.parse(fs.readFileSync(path.join(directory, split + '.json'))));
    Object.assign(fixtures, JSON.parse(fs.readFileSync(path.join(directory, split + '-fixtures.json'))));
  }
  const runtimeFingerprint = buildFingerprint(compiledBase);
  const hash = fingerprint(rows), env = { ...process.env, ...dotenv.parse(fs.readFileSync('.env')), ...dotenv.parse(fs.readFileSync(runtimeEnv)), RAG_COMPILED_AI_BASE: path.resolve(compiledBase), RAG_FROZEN_BACKEND_EMBEDDINGS: 'true', RAG_OPERATIONAL_DETERMINISTIC_LLM: mode === 'operational' ? 'true' : process.env.RAG_OPERATIONAL_DETERMINISTIC_LLM, LANGFUSE_RELEASE: 'frozen-replay-' + runtimeFingerprint.slice(0, 16), RELEASE_SHA: 'frozen-replay-' + runtimeFingerprint.slice(0, 16) };
  const keyCount = (env.GROQ_API_KEYS || env.GROQ_API_KEY).split(',').filter(Boolean).length;
  const models = new Set([env.AI_ANSWER_MODEL, env.AI_ROUTER_MODEL, 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'].filter(Boolean));
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const stateFile = path.join(output, 'state.json'), responseFile = path.join(output, 'responses.jsonl');
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile)) : { datasetSha256: hash, compiledBase: path.resolve(compiledBase), runType: 'FROZEN_BACKEND_REPLAY_NOT_PRODUCTION_RETRIEVAL', datasetName: `rag-coverage-${hash.slice(0, 16)}`, datasetRunId: null, snapshotFingerprint: hash, datasetSnapshot: rows, cases: Object.fromEntries(rows.map((r) => [r.id, { status: 'PENDING', attemptCount: 0 }])) };
  state.snapshotFingerprint ||= hash;
  state.datasetSnapshot ||= rows;
  state.datasetName ||= `rag-coverage-${hash.slice(0, 16)}`;
  if (state.datasetSha256 !== hash || state.compiledBase !== path.resolve(compiledBase) || (state.buildFingerprint && state.buildFingerprint !== runtimeFingerprint)) throw new Error('Run provenance changed');
  state.buildFingerprint = runtimeFingerprint;
  state.buildFingerprintVersion = 'compiled-ai-runtime-tree-v1';
  const save = () => { fs.writeFileSync(stateFile + '.tmp', JSON.stringify(state, null, 2), { mode: 0o600 }); fs.renameSync(stateFile + '.tmp', stateFile); };
  if (Object.values(state.cases).some((c) => c.status === 'IN_FLIGHT')) throw new Error('Unresolved primary request; reconcile persisted response before resume');
  save();
  const child = cp.spawn(process.execPath, [path.join(__dirname, 'rag-coverage-worker.cjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(path.join(output, 'worker.log'), { flags: 'a', mode: 0o600 });
  child.stderr.on('data', (d) => log.write(d));
  let pending, resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    log.write(line + '\n');
    if (line.startsWith('__READY__')) resolveReady();
    if (line.startsWith('__USAGE__')) fs.appendFileSync(ledgerPath, line.slice(9) + '\n', { mode: 0o600 });
    if (line.startsWith('__RESULT__') && pending) { const p = pending; pending = undefined; p.resolve(JSON.parse(line.slice(10))); }
  });
  const exit = new Promise((resolve) => child.on('exit', (code) => { rejectReady(new Error('Worker exited before ready')); if (pending) pending.reject(new Error('Worker exited with in-flight request; no retry')); resolve(code); }));
  try {
    await ready; state.status = 'RUNNING'; save();
    for (const row of rows.filter((r) => state.cases[r.id].status === 'PENDING')) {
      const day = new Date().toISOString().slice(0, 10), usage = {};
      if (fs.existsSync(ledgerPath)) for (const line of fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').filter(Boolean)) {
        const r = JSON.parse(line); if (r.at.slice(0, 10) === day) usage[r.keyIndex + ':' + r.model] = (usage[r.keyIndex + ':' + r.model] || 0) + r.totalTokens - r.cachedTokens;
      }
      const estimatedTokensPerCase = Number(env.ESTIMATED_TOKENS_PER_CASE || 5500);
      const tpdLimit = env.GROQ_PAID_TIER === 'true' ? Infinity : Number(env.GROQ_TPD_LIMIT || 145000);
      const keys = mode === 'operational'
        ? [0]
        : Array.from({ length: keyCount }, (_, i) => i).filter((i) => [...models].every((m) => (usage[i + ':' + m] || 0) + estimatedTokensPerCase <= tpdLimit));
      if (!keys.length) { state.status = 'WAITING_FOR_UTC_RESET'; const reset = new Date(); reset.setUTCHours(24, 1, 30, 0); state.nextResumeAt = reset.toISOString(); save(); break; }
      const c = state.cases[row.id]; c.status = 'IN_FLIGHT'; c.attemptCount = 1; c.startedAt = new Date().toISOString(); save();
      const promise = new Promise((resolve, reject) => { pending = { resolve, reject }; });
      child.stdin.write(JSON.stringify({ row: { id: row.id, input: row.input, metadata: row.metadata }, fixture: fixtures[row.id], keyStartIndex: keys[Object.values(state.cases).filter((x) => x.status === 'COMPLETED').length % keys.length] }) + '\n');
      const r = await promise;
      if (r.caseId !== row.id) throw new Error('Response identity mismatch');
      fs.appendFileSync(responseFile, JSON.stringify(r) + '\n', { mode: 0o600 });
      if (mode === 'operational' && fixtures[row.id].fault.stage === 'execution') {
        const duplicate = new Promise((resolve, reject) => { pending = { resolve, reject }; });
        child.stdin.write(JSON.stringify({ row: { id: row.id, input: row.input, metadata: row.metadata }, fixture: fixtures[row.id] }) + '\n');
        const refused = await duplicate;
        state.cases[row.id].duplicatePrimaryRefused = refused.error?.code === 'DUPLICATE_PRIMARY_REFUSED';
        if (!state.cases[row.id].duplicatePrimaryRefused) throw new Error('Duplicate guard failed');
      }
      const diag = r.trace?.workflowMetrics?.diagnostics || {};
      if (!diag.productionExecutionId && !r.error && !(mode === 'operational' && fixtures[row.id].fault.stage === 'trace')) throw new Error('Missing real execution ID');
      c.status = r.error ? 'FAILED' : 'COMPLETED';
      c.productionExecutionId = diag.productionExecutionId;
      c.error = r.error || undefined;
      c.finalFailureSource = diag.finalFailureSource;
      c.traceId = diag.langfuseTraceId;
      c.executionHealth = executionHealth(r);
      c.output = {
        ...(r.output || {}),
        generationEvidence: diag.generationEvidence || [],
        executionHealth: c.executionHealth,
        traceId: c.traceId,
      };
      c.finishedAt = new Date().toISOString(); save();
      const n = Object.values(state.cases).filter((x) => x.status === 'COMPLETED').length;
      console.log(JSON.stringify({ completed: n, total: rows.length, caseId: row.id, status: c.status }));
      if (mode === 'operational') {
        c.faultEvents = r.fixtureEvents || [];
        c.traceMissingAsExpected = fixtures[row.id].fault.stage === 'trace' ? !r.trace : undefined;
        if (fixtures[row.id].fault.stage === 'judge') {
          const { createFixturePorts } = require('./rag-coverage-fixture.cjs');
          const p = createFixturePorts(fixtures[row.id]);
          try { p.fault('judge'); throw new Error('Judge fault was not injected'); } catch (error) {
            if (!['GROQ_KEY_POOL_EXHAUSTED', 'ETIMEDOUT'].includes(error.code)) throw error;
            c.judgeStatus = 'UNAVAILABLE'; c.judgeScores = null; c.faultEvents.push(...p.events);
          }
        }
        save();
      } else if (/GROQ_KEY_POOL_EXHAUSTED|TOKENS_PER_DAY_EXHAUSTED|AUTH_OR_CONFIGURATION_FAILURE/.test(JSON.stringify({ error: r.error, diagnostics: diag }))) {
        state.status = 'HALTED_PROVIDER_OR_EXECUTION'; save(); break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (Object.values(state.cases).every((c) => c.status === 'COMPLETED')) { state.status = 'COMPLETE'; state.completedAt = new Date().toISOString(); }
    else if (Object.values(state.cases).every((c) => ['COMPLETED', 'FAILED'].includes(c.status))) { state.status = 'COMPLETE_WITH_EXECUTION_FAILURES'; state.completedAt = new Date().toISOString(); }
    save();
  } finally { child.stdin.end(JSON.stringify({ stop: true }) + '\n'); await exit; log.end(); }
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { compiledRuntimeFiles, buildFingerprint };
