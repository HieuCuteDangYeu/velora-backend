'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = process.cwd();
const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const datasetDir = path.resolve(
  value(
    'dataset',
    '.benchmarks/rag-remediation-v2-20261014-01/dataset-v6-series-holdout',
  ),
);
const baselineDir = path.resolve(
  value(
    'baseline-dir',
    '.benchmarks/rag-remediation-v2-20261014-01/evaluation-v6-baseline',
  ),
);
const candidateDir = path.resolve(
  value(
    'candidate-dir',
    '.benchmarks/rag-remediation-v2-20261014-01/evaluation-v6-candidate',
  ),
);
const baselineBuild = path.resolve(
  value(
    'baseline-build',
    '.benchmarks/rag-remediation-v2-20261010-01/build/ai/apps/ai-service/src',
  ),
);
const candidateBuild = path.resolve(
  value('candidate-build', 'dist/apps/ai-service/apps/ai-service/src'),
);
const runtimeEnv = path.resolve(
  value(
    'runtime-env',
    '.benchmarks/reviewed-rag50-final-v2-20261006-01/runtime.env',
  ),
);
const ledger = path.resolve(
  value(
    'ledger',
    '.benchmarks/rag-remediation-v2-20261014-01/shared-usage.jsonl',
  ),
);
const statusPath = path.resolve(
  value(
    'status',
    '.benchmarks/rag-remediation-v2-20261014-01/v6-supervisor-status.json',
  ),
);
const lockPath = `${statusPath}.lock`;

const runner = path.resolve('scripts/ops/run-rag-coverage-evaluation.cjs');
const terminal = new Set(['COMPLETE', 'COMPLETE_WITH_EXECUTION_FAILURES']);
const pauseStates = new Set([
  'WAITING_FOR_UTC_RESET',
  'HALTED_PROVIDER_OR_EXECUTION',
]);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeStatus(valueToWrite) {
  fs.mkdirSync(path.dirname(statusPath), { recursive: true, mode: 0o700 });
  const temp = `${statusPath}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(valueToWrite, null, 2), {
    mode: 0o600,
  });
  fs.renameSync(temp, statusPath);
}

function countCases(state) {
  const entries = Object.values(state.cases || {});
  return {
    total: entries.length,
    completed: entries.filter((entry) => entry.status === 'COMPLETED').length,
    failed: entries.filter((entry) => entry.status === 'FAILED').length,
    pending: entries.filter((entry) => entry.status === 'PENDING').length,
    inFlight: entries.filter((entry) => entry.status === 'IN_FLIGHT').length,
  };
}

function cohortAction(state, now = Date.now(), cohort = 'Cohort') {
  if (state.inFlight || countCases(state).inFlight > 0)
    throw new Error(`${cohort} has unresolved IN_FLIGHT work`);
  if (terminal.has(state.status)) return 'COMPLETE';
  if (state.status === 'WAITING_FOR_UTC_RESET') {
    const nextResumeAt = Date.parse(state.nextResumeAt || '');
    if (!Number.isFinite(nextResumeAt))
      throw new Error(`${cohort} is waiting without a valid nextResumeAt`);
    return nextResumeAt > now ? 'WAIT_FOR_RESET' : 'RUNNER';
  }
  return state.status === 'HALTED_PROVIDER_OR_EXECUTION' ? 'HALTED' : 'RUNNER';
}

function sleep(milliseconds) {
  return new Promise((resolve) =>
    setTimeout(resolve, Math.min(milliseconds, 60_000)),
  );
}

function runCohortRunner(runDir, buildDir) {
  const child = spawn(
    process.execPath,
    [runner, datasetDir, runDir, buildDir, runtimeEnv, ledger, 'regular'],
    {
      cwd: root,
      stdio: 'inherit',
    },
  );
  return new Promise((resolve) =>
    child.once('exit', (code) => resolve(code ?? 1)),
  );
}

async function initializeCohortIfNeeded(cohort, runDir, buildDir) {
  if (fs.existsSync(path.join(runDir, 'state.json'))) return;
  writeStatus({
    status: 'INITIALIZING_COHORT',
    cohort,
    updatedAt: new Date().toISOString(),
  });
  const exitCode = await runCohortRunner(runDir, buildDir);
  if (!fs.existsSync(path.join(runDir, 'state.json'))) {
    throw new Error(`${cohort} runner exited without creating state.json`);
  }
  if (exitCode !== 0) {
    throw new Error(`${cohort} initialization runner exited with ${exitCode}`);
  }
}

async function waitForReset(state, cohort) {
  const next = Date.parse(state.nextResumeAt || '');
  if (!Number.isFinite(next))
    throw new Error(`${cohort} is waiting without a valid nextResumeAt`);
  while (Date.now() < next) {
    const current = readJson(
      path.join(
        cohort === 'baseline' ? baselineDir : candidateDir,
        'state.json',
      ),
    );
    if (current.status !== 'WAITING_FOR_UTC_RESET') return;
    writeStatus({
      status: 'WAITING_FOR_UTC_RESET',
      cohort,
      nextResumeAt: current.nextResumeAt,
      counts: countCases(current),
      updatedAt: new Date().toISOString(),
    });
    await sleep(Math.max(1_000, Math.min(next - Date.now(), 60_000)));
  }
}

async function runCohort(cohort, runDir, buildDir) {
  const statePath = path.join(runDir, 'state.json');
  await initializeCohortIfNeeded(cohort, runDir, buildDir);
  while (true) {
    const state = readJson(statePath);
    const action = cohortAction(state, Date.now(), cohort);
    if (action === 'COMPLETE') {
      writeStatus({
        status: `${cohort.toUpperCase()}_COMPLETE`,
        cohort,
        counts: countCases(state),
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    if (action === 'WAIT_FOR_RESET') {
      await waitForReset(state, cohort);
      continue;
    }
    if (action === 'HALTED') {
      writeStatus({
        status: 'HALTED_PROVIDER_OR_EXECUTION',
        cohort,
        counts: countCases(state),
        reason:
          'Cohort requires provider or execution reconciliation before resume.',
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    writeStatus({
      status: 'RUNNING',
      cohort,
      counts: countCases(state),
      updatedAt: new Date().toISOString(),
    });
    const exitCode = await runCohortRunner(runDir, buildDir);
    const after = readJson(statePath);
    if (terminal.has(after.status)) continue;
    if (after.status === 'WAITING_FOR_UTC_RESET') continue;
    if (after.status === 'HALTED_PROVIDER_OR_EXECUTION') continue;
    if (exitCode !== 0)
      throw new Error(
        `${cohort} runner exited with ${exitCode} and state=${after.status}`,
      );
    throw new Error(
      `${cohort} runner exited without a resumable terminal state: ${after.status}`,
    );
  }
}

function acquireLock() {
  try {
    const descriptor = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(
      descriptor,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    return () => {
      try {
        fs.closeSync(descriptor);
      } catch {}
      try {
        fs.unlinkSync(lockPath);
      } catch {}
    };
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(`v6 supervisor lock exists: ${lockPath}`);
    throw error;
  }
}

async function main() {
  const release = acquireLock();
  try {
    await runCohort('baseline', baselineDir, baselineBuild);
    await runCohort('candidate', candidateDir, candidateBuild);
    writeStatus({
      status: 'PRIMARY_COHORTS_COMPLETE',
      updatedAt: new Date().toISOString(),
    });
  } finally {
    release();
  }
}

if (require.main === module) {
  main().catch((error) => {
    writeStatus({
      status: 'BLOCKED',
      reason: error.message,
      updatedAt: new Date().toISOString(),
    });
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { cohortAction, countCases };
