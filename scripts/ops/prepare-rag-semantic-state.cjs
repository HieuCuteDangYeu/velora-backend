'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fingerprint } = require('./rag-evaluation-contract.cjs');

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
    return {
      status: 'FAILED',
      failedStages: [response.error.code || response.error.name || 'WORKFLOW_ERROR'],
    };
  }
  const diagnostics = response.trace?.workflowMetrics?.diagnostics || {};
  const statuses = providerStatuses(diagnostics);
  const degraded =
    diagnostics.evaluationCapture?.contextCaptured !== true ||
    (diagnostics.finalFailureSource && diagnostics.finalFailureSource !== 'NONE') ||
    statuses.some(
      (status) =>
        status === 'ERROR' ||
        status === 'TIMEOUT' ||
        status === 'NETWORK_ERROR' ||
        (typeof status === 'number' && status >= 400),
    );
  return {
    status: degraded ? 'DEGRADED' : 'AVAILABLE',
    failedStages: degraded ? ['PROVIDER_OR_CAPTURE_DEGRADED'] : [],
  };
}

function prepare({ datasetDir, runDir, outputPath }) {
  const rows = ['development', 'held_out'].flatMap((split) =>
    readJson(path.join(datasetDir, `${split}.json`)),
  );
  const state = readJson(path.join(runDir, 'state.json'));
  const responses = readJsonl(path.join(runDir, 'responses.jsonl'));
  const responseById = new Map(responses.map((response) => [response.caseId, response]));
  if (responses.length !== rows.length || responseById.size !== rows.length) {
    throw new Error('Primary responses must contain exactly one record per dataset case');
  }
  if (Object.values(state.cases || {}).some((entry) => !['COMPLETED', 'FAILED'].includes(entry.status))) {
    throw new Error('Primary state is not terminal; refusing semantic-state preparation');
  }

  const cases = Object.fromEntries(
    rows.map((row) => {
      const response = responseById.get(row.id);
      const diagnostics = response.trace?.workflowMetrics?.diagnostics || {};
      const health = executionHealth(response);
      return [
        row.id,
        {
          status: response.error ? 'FAILED' : 'COMPLETED',
          productionExecutionId: diagnostics.productionExecutionId,
          traceId: diagnostics.langfuseTraceId,
          output: {
            ...(response.output || {}),
            generationEvidence: diagnostics.generationEvidence || [],
            executionHealth: health,
            traceId: diagnostics.langfuseTraceId,
          },
          error: response.error,
        },
      ];
    }),
  );
  const result = {
    runId: state.runId || path.basename(runDir),
    datasetName: `rag-coverage-${fingerprint(rows).slice(0, 16)}`,
    datasetRunId: state.datasetRunId || null,
    datasetSnapshot: rows,
    snapshotFingerprint: fingerprint(rows),
    sourceStateFingerprint: fingerprint(state),
    sourceResponsesFingerprint: fingerprint(responses),
    preparedAt: new Date().toISOString(),
    cases,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), { mode: 0o600 });
  return result;
}

if (require.main === module) {
  const [datasetDir, runDir, outputPath] = process.argv.slice(2);
  if (!datasetDir || !runDir || !outputPath) {
    throw new Error('Usage: prepare-rag-semantic-state <dataset-dir> <run-dir> <state.json>');
  }
  const result = prepare({ datasetDir, runDir, outputPath });
  console.log(
    JSON.stringify({
      outputPath,
      cases: Object.keys(result.cases).length,
      completed: Object.values(result.cases).filter((entry) => entry.status === 'COMPLETED').length,
      failed: Object.values(result.cases).filter((entry) => entry.status === 'FAILED').length,
    }),
  );
}

module.exports = { executionHealth, prepare, providerStatuses };
