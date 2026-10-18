'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const root = process.cwd();
const runDir = path.resolve(process.env.RAG_COHORT_RUN_DIR || '.benchmarks/rag-remediation-v2-20261010-01/evaluation');
const dataDir = path.resolve(process.env.RAG_COHORT_DATA_DIR || '.benchmarks/rag-memory-remediation-20261006-01/dataset-v5');
const buildProvenance = path.resolve(process.env.RAG_BUILD_PROVENANCE || '.benchmarks/rag-remediation-v2-20261010-01/evaluation-build-provenance.json');
const sharedLedger = path.resolve(process.env.RAG_COHORT_LEDGER || path.join(runDir, 'shared-usage.jsonl'));
const controllerFile = path.join(runDir, 'supervisor.json');
const lockFile = path.join(runDir, 'supervisor.lock');
const cohortScript = path.resolve('.benchmarks/rag-memory-remediation-20261006-01/cohort-resume-v5.cjs');
const semanticScript = path.resolve('.benchmarks/rag-memory-remediation-20261006-01/semantic-cohorts.cjs');
const finalizerScript = path.resolve('scripts/ops/finalize-rag-remediation-run.cjs');

const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
};
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 30_000)));

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    fs.statSync(`/proc/${pid}`);
    return true;
  } catch {
    return false;
  }
}

function acquireRunLock(file) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    try {
      descriptor = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      return () => {
        try {
          const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (owner.pid === process.pid) fs.unlinkSync(file);
        } catch {
          // An interrupted process may already have released or lost the lock.
        }
        try { fs.closeSync(descriptor); } catch {}
      };
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
      }
      if (error?.code !== 'EEXIST') throw error;
      let owner;
      try {
        owner = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        const lockError = new Error(`benchmark lock exists with an unreadable owner: ${file}`);
        lockError.code = 'RAG_RUN_LOCKED';
        throw lockError;
      }
      if (processIsAlive(Number(owner.pid))) {
        const lockError = new Error(`benchmark is already locked by pid ${owner.pid}: ${file}`);
        lockError.code = 'RAG_RUN_LOCKED';
        throw lockError;
      }
      fs.unlinkSync(file);
    }
  }
  throw new Error(`could not acquire benchmark lock: ${file}`);
}

const baseEnv = {
  ...process.env,
  RAG_COHORT_RUN_DIR: runDir,
  RAG_COHORT_DATA_DIR: dataDir,
  RAG_COHORT_LEDGER: sharedLedger,
  RAG_BUILD_PROVENANCE: buildProvenance,
  RAG_BASELINE_BUILD: path.resolve('.benchmarks/rag-memory-remediation-20261006-01/baseline-build/apps/ai-service/src'),
  RAG_PATCHED_BUILD: path.resolve('.benchmarks/rag-remediation-v2-20261010-01/build/ai/apps/ai-service/src'),
  RAG_RUNTIME_ENV: path.resolve('.benchmarks/reviewed-rag50-final-v2-20261006-01/runtime.env'),
  RAG_CONTROLLER_FILE: 'controller.json',
  RAG_SEMANTIC_RUN_DIR: runDir,
  RAG_SEMANTIC_DATA_DIR: dataDir,
  RAG_SEMANTIC_LEDGER: sharedLedger,
  RAG_SEMANTIC_CALIBRATION_DIR: path.resolve('.benchmarks/rag-memory-remediation-20261006-01/calibration-round2'),
  RAG_FINAL_RUN_DIR: runDir,
  RAG_FINAL_DATA_DIR: dataDir,
  RAG_FINAL_BUILD_PROVENANCE: buildProvenance,
};

function status() {
  return fs.existsSync(path.join(runDir, 'controller.json'))
    ? readJson(path.join(runDir, 'controller.json'))
    : {};
}

function spawnLogged(script, name) {
  const logPath = path.join(runDir, `${name}.log`);
  const log = fs.createWriteStream(logPath, { flags: 'a', mode: 0o600 });
  const child = cp.spawn(process.execPath, [script], {
    cwd: root,
    env: baseEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  return new Promise((resolve) => child.once('exit', (code) => { log.end(); resolve(code ?? 1); }));
}

async function main() {
  const releaseRunLock = acquireRunLock(lockFile);
  try {
  let observedPid = Number(process.argv[2] || 0);
  const state = { status: 'MONITORING', startedAt: new Date().toISOString(), observedPid };
  write(controllerFile, state);

  if (observedPid) {
    while (fs.existsSync(`/proc/${observedPid}`)) {
      state.status = 'ACTIVE_COHORT_PROCESS';
      write(controllerFile, state);
      await sleep(30_000);
    }
  }

  while (true) {
    const current = status();
    if (current.status === 'PRIMARY_COHORTS_COMPLETE') break;
    if (fs.existsSync(path.join(runDir, 'STOP_REMEDIATION'))) {
      state.status = 'STOP_REQUESTED';
      write(controllerFile, state);
      return;
    }
    if (current.status === 'WAITING_FOR_UTC_RESET' && current.nextResumeAt) {
      if (Date.now() < Date.parse(current.nextResumeAt)) {
        state.status = 'WAITING_FOR_UTC_RESET';
        state.nextResumeAt = current.nextResumeAt;
        write(controllerFile, state);
        while (Date.now() < Date.parse(current.nextResumeAt)) {
          if (fs.existsSync(path.join(runDir, 'STOP_REMEDIATION'))) return;
          await sleep(Date.parse(current.nextResumeAt) - Date.now());
        }
        continue;
      }
      state.status = 'RESUMING_PRIMARY_COHORTS';
      delete state.nextResumeAt;
      write(controllerFile, state);
    } else {
      state.status = current.status || 'RESUMING_PRIMARY_COHORTS';
      state.nextResumeAt = current.nextResumeAt;
      write(controllerFile, state);
    }
    const code = await spawnLogged(cohortScript, `cohort-resume-${Date.now()}`);
    if (code !== 0) throw new Error(`cohort runner exited with ${code}`);
    observedPid = 0;
  }

  while (true) {
    state.status = 'SEMANTIC_SCORING';
    write(controllerFile, state);
    const code = await spawnLogged(semanticScript, `semantic-resume-${Date.now()}`);
    if (code === 0) break;
    const semanticStatusPath = path.join(runDir, 'semantic-controller-status.json');
    if (!fs.existsSync(semanticStatusPath)) throw new Error('Semantic scoring stopped without a checkpoint');
    const semanticStatus = readJson(semanticStatusPath);
    if (semanticStatus.status !== 'WAITING_FOR_UTC_RESET') throw new Error('Semantic scoring requires reconciliation');
    state.nextResumeAt = semanticStatus.nextResumeAt;
    write(controllerFile, state);
    while (Date.now() < Date.parse(semanticStatus.nextResumeAt)) {
      if (fs.existsSync(path.join(runDir, 'STOP_REMEDIATION'))) return;
      await sleep(Date.parse(semanticStatus.nextResumeAt) - Date.now());
    }
  }

  state.status = 'FINALIZING';
  write(controllerFile, state);
  const finalizationCode = await spawnLogged(finalizerScript, `finalize-${Date.now()}`);
  if (finalizationCode !== 0) throw new Error(`finalization exited with ${finalizationCode}`);

  state.status = 'PRIMARY_AND_SEMANTIC_COMPLETE';
  state.finalBenchmark = path.join(runDir, 'final-benchmark.json');
  state.finishedAt = new Date().toISOString();
  write(controllerFile, state);
  } finally {
    releaseRunLock();
  }
}

main().catch((error) => {
  if (error?.code !== 'RAG_RUN_LOCKED') {
    write(controllerFile, { status: 'BLOCKED', reason: error.message, finishedAt: new Date().toISOString() });
  }
  console.error(error.message);
  process.exitCode = 1;
});
