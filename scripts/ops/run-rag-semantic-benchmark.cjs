#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  EVALUATOR_VERSION,
  fingerprint,
  executionHealth: classifyExecutionHealth,
} = require('./rag-evaluation-contract.cjs');
const {
  DIMENSIONS,
  isApplicable,
} = require('./rag-evaluation-applicability.cjs');
const {
  ELIGIBILITY_POLICY,
  dimensionAvailability,
} = require('./rag-semantic-eligibility.cjs');
const { buildDimensionPrompt } = require('./rag-judge-prompts.cjs');
const claudeJudge = require('./run-claude-rag-judge.cjs');

const JUDGES = {
  claude: {
    provider: 'claude-code-subscription',
    model: claudeJudge.model,
    code: 'CLAUDE',
    stateFile: 'claude-semantic-state.json',
    cliVersion: claudeJudge.installedClaudeVersion,
    runDimension: claudeJudge.runClaudeDimension,
  },
};
const DEFAULT_JUDGE = 'claude';

function parseArgs(argv) {
  const positional = [];
  let limitScores;
  let judge = DEFAULT_JUDGE;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value?.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const [name, inline] = value.slice(2).split('=', 2);
    const next = argv[index + 1];
    const argument =
      inline ?? (next && !next.startsWith('--') ? argv[++index] : undefined);
    if (name === 'limit-scores' && argument !== undefined)
      limitScores = Number.parseInt(argument, 10);
    else if (name === 'judge' && argument !== undefined) judge = argument;
    else throw new Error(`Unknown or incomplete option: --${name}`);
  }
  if (positional.length !== 2)
    throw new Error(
      'Usage: run-rag-semantic-benchmark <dataset-dir> <cohort-dir> [--judge claude] [--limit-scores N]',
    );
  if (!Object.hasOwn(JUDGES, judge))
    throw new Error(
      '--judge must be one of: ' + Object.keys(JUDGES).join(', '),
    );
  if (
    limitScores !== undefined &&
    (!Number.isInteger(limitScores) || limitScores < 1)
  )
    throw new Error('--limit-scores must be a positive integer');
  return {
    datasetDir: path.resolve(positional[0]),
    cohortDir: path.resolve(positional[1]),
    limitScores,
    judge,
  };
}

function judgeFailureCode(error, code = 'CLAUDE') {
  const message = error instanceof Error ? error.message : String(error);
  if (/429|rate|limit|quota|usage/i.test(message)) return `${code}_USAGE_LIMIT`;
  if (/ETIMEDOUT|timeout|timed out/i.test(message)) return `${code}_TIMEOUT`;
  return `${code}_JUDGE_ERROR`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonl(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function sha256File(file) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex');
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}

function acquireLock(file) {
  const descriptor = fs.openSync(file, 'wx', 0o600);
  fs.writeFileSync(descriptor, `${process.pid}\n`);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    fs.closeSync(descriptor);
    fs.rmSync(file, { force: true });
    process.removeListener('exit', release);
  };
  process.once('exit', release);
  return release;
}

function referenceAnswer(expectedOutput) {
  if (
    Array.isArray(expectedOutput?.acceptedAnswers) &&
    expectedOutput.acceptedAnswers.length
  ) {
    return expectedOutput.acceptedAnswers;
  }
  return expectedOutput?.referenceAnswer ?? expectedOutput?.answer ?? '';
}

function contextForJudge(diagnostics) {
  if (
    diagnostics?.evaluationCapture?.contextCaptured !== true ||
    !Array.isArray(diagnostics.generationEvidence)
  ) {
    return undefined;
  }
  return diagnostics.generationEvidence.slice(0, 12).map((item) => ({
    sourceId: item.sourceId ?? item.evidenceId,
    title: item.title,
    evidenceType: item.evidenceType,
    startTime: item.startTime,
    endTime: item.endTime,
    evidenceText: String(item.evidenceText ?? '').slice(0, 2_000),
  }));
}

function pendingDimensionTasks(rows, caseStates, dimensionsForRow) {
  return rows.flatMap((row) =>
    dimensionsForRow(row)
      .filter((dimension) => {
        const saved = caseStates[row.id]?.scores?.[dimension];
        return typeof saved?.score !== 'number' && !saved?.unavailableReason;
      })
      .map((dimension) => ({ caseId: row.id, dimension })),
  );
}

function reconcileDimensionScores(existingScores, unavailable) {
  const scores = { ...existingScores };
  for (const dimension of DIMENSIONS) {
    if (unavailable[dimension]) {
      scores[dimension] = unavailable[dimension];
    } else if (scores[dimension]?.unavailableReason) {
      delete scores[dimension];
    }
  }
  return scores;
}

function semanticRows(rows, caseStates, runMetadata) {
  return rows.map((row) => ({
    caseId: row.id,
    evaluatorVersion: EVALUATOR_VERSION,
    eligibilityPolicy: ELIGIBILITY_POLICY,
    judgeProvider: runMetadata.judgeProvider ?? JUDGES[DEFAULT_JUDGE].provider,
    judgeModel: runMetadata.judgeModel ?? JUDGES[DEFAULT_JUDGE].model,
    judgeFingerprint: runMetadata.judgeFingerprint,
    executionHealth: runMetadata.healthById[row.id],
    scores: caseStates[row.id]?.scores ?? {},
  }));
}

function validateCohort(datasetDir, cohortDir) {
  const rows = ['development', 'held_out'].flatMap((split) =>
    readJson(path.join(datasetDir, `${split}.json`)),
  );
  const datasetSha256 = fingerprint(rows);
  const cohortState = readJson(path.join(cohortDir, 'state.json'));
  const responsesPath = path.join(cohortDir, 'responses.jsonl');
  const responses = readJsonl(responsesPath);
  const responseById = new Map(
    responses.map((response) => [response.caseId, response]),
  );
  const rowIds = new Set(rows.map((row) => row.id));
  const executionIds = responses.map(
    (response) =>
      response.trace?.workflowMetrics?.diagnostics?.productionExecutionId,
  );
  if (
    datasetSha256 !== cohortState.datasetSha256 ||
    !['COMPLETE', 'COMPLETE_WITH_EXECUTION_FAILURES'].includes(
      cohortState.status,
    ) ||
    Object.values(cohortState.cases ?? {}).some(
      (entry) => !['COMPLETED', 'FAILED'].includes(entry.status),
    ) ||
    responses.length !== rows.length ||
    new Set(responses.map((response) => response.caseId)).size !==
      rows.length ||
    responses.some((response) => !rowIds.has(response.caseId)) ||
    executionIds.some((id) => !id) ||
    new Set(executionIds).size !== rows.length
  ) {
    throw new Error(
      'Cohort is not a complete exact-once response set for this dataset',
    );
  }
  return { rows, cohortState, responseById, datasetSha256, responsesPath };
}

function unavailableScores(row, health, output) {
  const scores = {};
  if (health === 'AVAILABLE') {
    const availability = dimensionAvailability(row, output);
    for (const dimension of DIMENSIONS) {
      if (
        isApplicable(row, dimension) &&
        availability[dimension] !== 'AVAILABLE'
      ) {
        scores[dimension] = {
          unavailableReason: availability[dimension],
        };
      }
    }
    return scores;
  }
  for (const dimension of DIMENSIONS) {
    if (!isApplicable(row, dimension)) continue;
    scores[dimension] = { unavailableReason: `EXECUTION_HEALTH_${health}` };
  }
  return scores;
}

function prepareRun(datasetDir, cohortDir, judge = JUDGES[DEFAULT_JUDGE]) {
  const data = validateCohort(datasetDir, cohortDir);
  const cliVersion = judge.cliVersion();

  const healthById = {};
  const cases = {};
  for (const row of data.rows) {
    const response = data.responseById.get(row.id);
    const diagnostics = response.trace?.workflowMetrics?.diagnostics ?? {};
    const health = response.error
      ? 'FAILED'
      : classifyExecutionHealth(diagnostics).status;
    healthById[row.id] = health;
    const outputForEligibility = {
      ...(response.output ?? {}),
      contextCaptureStatus:
        diagnostics.evaluationCapture?.contextCaptured === true
          ? 'CAPTURED'
          : 'NOT_CAPTURED',
      generationEvidence: diagnostics.generationEvidence ?? [],
      executionHealth: { status: health },
    };
    cases[row.id] = {
      scores: unavailableScores(row, health, outputForEligibility),
    };
  }
  const fingerprintInput = {
    // Persisted identifier: renaming it would invalidate existing judge checkpoint fingerprints.
    schema: 'rag-codex-semantic-run-v1',
    evaluatorVersion: EVALUATOR_VERSION,
    eligibilityPolicy: ELIGIBILITY_POLICY,
    model: judge.model,
    cliVersion,
    datasetSha256: data.datasetSha256,
    buildFingerprint: data.cohortState.buildFingerprint,
    responseSha256: sha256File(data.responsesPath),
    dimensions: DIMENSIONS,
    contextPolicy: 'CAPTURED_GENERATION_EVIDENCE_ONLY',
  };
  const legacyJudgeFingerprint = fingerprint(fingerprintInput);
  const judgeFingerprint = fingerprint({
    ...fingerprintInput,
    executionHealthPolicy: 'rag-evaluation-contract-execution-health-v1',
  });
  return {
    ...data,
    model: judge.model,
    cliVersion,
    healthById,
    cases,
    legacyJudgeFingerprint,
    judgeFingerprint,
  };
}

function migrateLegacyCheckpoint(state, prepared, statePath, outputPath) {
  const stateBackupPath = `${statePath}.health-v1`;
  const outputBackupPath = `${outputPath}.health-v1`;
  if (fs.existsSync(stateBackupPath) || fs.existsSync(outputBackupPath))
    throw new Error('Health-policy migration backup already exists');
  fs.copyFileSync(statePath, stateBackupPath, fs.constants.COPYFILE_EXCL);
  if (fs.existsSync(outputPath)) {
    fs.copyFileSync(outputPath, outputBackupPath, fs.constants.COPYFILE_EXCL);
    fs.rmSync(outputPath);
  }

  for (const row of prepared.rows) {
    const entry = state.cases[row.id];
    entry.scores = reconcileDimensionScores(
      entry.scores ?? {},
      prepared.cases[row.id].scores,
    );
  }
  state.previousJudgeFingerprint = state.judgeFingerprint;
  state.judgeFingerprint = prepared.judgeFingerprint;
  state.executionHealthPolicy = 'rag-evaluation-contract-execution-health-v1';
  state.healthById = prepared.healthById;
  state.status = 'IN_PROGRESS';
  delete state.completedAt;
  state.completedScores = Object.values(state.cases).reduce(
    (count, entry) =>
      count +
      Object.values(entry.scores ?? {}).filter(
        (score) => typeof score?.score === 'number',
      ).length,
    0,
  );
  state.pendingScores = pendingDimensionTasks(
    prepared.rows,
    state.cases,
    (row) => DIMENSIONS.filter((dimension) => isApplicable(row, dimension)),
  ).length;
  state.migratedAt = new Date().toISOString();
  state.healthPolicyMigration = {
    previousCheckpoint: path.basename(stateBackupPath),
    previousSemanticOutput: fs.existsSync(outputBackupPath)
      ? path.basename(outputBackupPath)
      : null,
  };
  writeJsonAtomic(statePath, state);
  return state;
}

function main() {
  const {
    datasetDir,
    cohortDir,
    limitScores,
    judge: judgeName,
  } = parseArgs(process.argv.slice(2));
  const judge = JUDGES[judgeName];
  const outputPath = path.join(cohortDir, 'semantic-cases.jsonl');
  const statePath = path.join(cohortDir, judge.stateFile);
  const lockPath = `${statePath}.lock`;
  const releaseLock = acquireLock(lockPath);
  try {
    const prepared = prepareRun(datasetDir, cohortDir, judge);
    let state;
    if (fs.existsSync(statePath)) {
      state = readJson(statePath);
      if (
        state.judgeFingerprint === prepared.legacyJudgeFingerprint &&
        !state.executionHealthPolicy
      ) {
        state = migrateLegacyCheckpoint(state, prepared, statePath, outputPath);
      } else if (state.judgeFingerprint !== prepared.judgeFingerprint) {
        throw new Error(
          'Semantic checkpoint belongs to different inputs or model',
        );
      }
      if (state.status === 'COMPLETE') {
        if (!fs.existsSync(outputPath))
          throw new Error(
            'Completed semantic checkpoint is missing semantic-cases.jsonl',
          );
        console.log(JSON.stringify({ status: 'COMPLETE', outputPath }));
        return;
      }
    } else {
      if (fs.existsSync(outputPath))
        throw new Error(
          'Semantic output exists without its checkpoint; refusing overwrite',
        );
      state = {
        schemaVersion: 'rag-codex-semantic-run-v1',
        provider: judge.provider,
        model: prepared.model,
        judgeCliVersion: prepared.cliVersion,
        evaluatorVersion: EVALUATOR_VERSION,
        eligibilityPolicy: ELIGIBILITY_POLICY,
        datasetSha256: prepared.datasetSha256,
        sourceBuildFingerprint: prepared.cohortState.buildFingerprint,
        sourceRunType: prepared.cohortState.runType,
        responseSha256: sha256File(prepared.responsesPath),
        judgeFingerprint: prepared.judgeFingerprint,
        executionHealthPolicy: 'rag-evaluation-contract-execution-health-v1',
        healthById: prepared.healthById,
        cases: prepared.cases,
        status: 'IN_PROGRESS',
        startedAt: new Date().toISOString(),
      };
      writeJsonAtomic(statePath, state);
    }

    const pending = pendingDimensionTasks(prepared.rows, state.cases, (row) =>
      DIMENSIONS.filter((dimension) => isApplicable(row, dimension)),
    );
    const totalTasks = pending.length;
    const tasks =
      limitScores === undefined ? pending : pending.slice(0, limitScores);
    let completedThisInvocation = 0;
    for (const { caseId, dimension } of tasks) {
      const row = prepared.rows.find((candidate) => candidate.id === caseId);
      const response = prepared.responseById.get(caseId);
      const diagnostics = response.trace?.workflowMetrics?.diagnostics ?? {};
      const prompt = buildDimensionPrompt(dimension, {
        question: row.input?.question,
        referenceAnswer: row.expectedOutput?.acceptedAnswers?.length
          ? row.expectedOutput.acceptedAnswers
          : (row.expectedOutput?.referenceAnswer ??
            row.expectedOutput?.answer ??
            ''),
        generatedAnswer: response.output?.answer ?? '',
        context: contextForJudge(diagnostics),
        answerType: row.metadata?.answerType,
        policyAssertions: row.expectedOutput?.assertions,
        expectedEvidenceTypes: row.expectedOutput?.expectedEvidenceTypes,
      });
      try {
        state.cases[caseId].scores[dimension] = judge.runDimension(
          dimension,
          prompt,
        );
      } catch (error) {
        state.status = 'PAUSED';
        state.lastFailure = {
          caseId,
          dimension,
          code: judgeFailureCode(error, judge.code),
          at: new Date().toISOString(),
        };
        writeJsonAtomic(statePath, state);
        throw new Error(
          `Claude semantic judge paused at ${caseId}/${dimension}; checkpoint saved`,
        );
      }
      state.status = 'IN_PROGRESS';
      state.completedScores = (state.completedScores ?? 0) + 1;
      state.lastFailure = undefined;
      state.updatedAt = new Date().toISOString();
      writeJsonAtomic(statePath, state);
      completedThisInvocation += 1;
      process.stdout.write(
        `${JSON.stringify({ caseId, dimension, completedThisInvocation, pendingAtStart: totalTasks, model: judge.model })}\n`,
      );
    }

    const remaining = pendingDimensionTasks(prepared.rows, state.cases, (row) =>
      DIMENSIONS.filter((dimension) => isApplicable(row, dimension)),
    );
    if (remaining.length === 0) {
      const records = semanticRows(prepared.rows, state.cases, {
        judgeFingerprint: prepared.judgeFingerprint,
        healthById: prepared.healthById,
        judgeProvider: judge.provider,
        judgeModel: judge.model,
      });
      const temporary = `${outputPath}.${process.pid}.tmp`;
      fs.writeFileSync(
        temporary,
        `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
        { mode: 0o600 },
      );
      fs.renameSync(temporary, outputPath);
      state.status = 'COMPLETE';
      state.completedAt = new Date().toISOString();
      state.pendingScores = 0;
    } else {
      state.pendingScores = remaining.length;
    }
    writeJsonAtomic(statePath, state);
    console.log(
      JSON.stringify({
        status: state.status,
        scoredThisInvocation: completedThisInvocation,
        pendingScores: state.pendingScores,
        outputPath: state.status === 'COMPLETE' ? outputPath : undefined,
        model: judge.model,
      }),
    );
  } finally {
    releaseLock();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}

module.exports = {
  parseArgs,
  contextForJudge,
  pendingDimensionTasks,
  semanticRows,
  unavailableScores,
  reconcileDimensionScores,
  judgeFailureCode,
  JUDGES,
  validateCohort,
};
