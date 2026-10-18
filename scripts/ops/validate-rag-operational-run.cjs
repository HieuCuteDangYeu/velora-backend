'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function writeJson(file, value) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function validate({ datasetDir, runDir, outputPath }) {
  const rows = readJson(path.join(datasetDir, 'operational.json'));
  const state = readJson(path.join(runDir, 'state.json'));
  const responses = readJsonl(path.join(runDir, 'responses.jsonl'));
  const responseById = new Map(responses.map((response) => [response.caseId, response]));
  const unverified = [];
  const cases = rows.map((row) => {
    const stateCase = state.cases?.[row.id];
    const response = responseById.get(row.id);
    const events = [
      ...(response?.fixtureEvents || []),
      ...(stateCase?.faultEvents || []),
    ];
    const expectedStage = row.metadata?.faultStage;
    const expectedType = row.metadata?.faultType;
    const eventObserved = events.some((event) => event.stage === expectedStage && event.type === expectedType && event.injected === true);
    const duplicateRefused = expectedStage === 'execution' ? stateCase?.duplicatePrimaryRefused === true : null;
    const traceMissing = expectedStage === 'trace' ? stateCase?.traceMissingAsExpected === true : null;
    const injectionObserved = expectedStage === 'execution' ? duplicateRefused : expectedStage === 'trace' ? traceMissing : eventObserved;
    const executionId = stateCase?.productionExecutionId || response?.trace?.workflowMetrics?.diagnostics?.productionExecutionId;
    const executionIdRequired = expectedStage !== 'trace';
    const executionIdValid = !executionIdRequired || Boolean(executionId);
    const result = {
      caseId: row.id,
      stage: expectedStage,
      type: expectedType,
      workflowStatus: stateCase?.status,
      responseError: response?.error?.code,
      injectionObserved,
      duplicatePrimaryRefused: duplicateRefused,
      traceMissingAsExpected: traceMissing,
      executionId,
      executionIdPresent: Boolean(executionId),
      executionIdRequired,
      executionIdValid,
      eventCount: events.length,
    };
    if (!injectionObserved || !executionIdValid || !stateCase || !response) unverified.push(result);
    return result;
  });
  const executionIdValues = cases.filter((item) => item.executionIdPresent).map((item) => item.executionId);
  const executionIdsUnique = new Set(executionIdValues).size === executionIdValues.length;
  if (!executionIdsUnique) unverified.push({ kind: 'DUPLICATE_EXECUTION_ID' });
  const uniqueResponseIds = new Set(responses.map((response) => response.caseId));
  const result = {
    status: unverified.length === 0 && responses.length === rows.length && uniqueResponseIds.size === rows.length
      ? 'PASS'
      : 'FAIL',
    mode: 'ISOLATED_SYNTHETIC_FIXTURE_DETERMINISTIC_LLM',
    executed: rows.length,
    responseRecords: responses.length,
    uniqueResponseRecords: uniqueResponseIds.size,
    workflowResponses: rows.reduce((counts, row) => {
      const status = state.cases?.[row.id]?.status || 'MISSING';
      counts[status] = (counts[status] || 0) + 1;
      return counts;
    }, {}),
    injectionExplicitlyObserved: cases.filter((item) => item.injectionObserved).length,
    unverifiedInjectionCases: unverified,
    executionIdCases: executionIdValues.length,
    executionIdsUnique,
    duplicatePrimaryRefusalCases: cases.filter((item) => item.duplicatePrimaryRefused === true).length,
    traceLossCases: cases.filter((item) => item.traceMissingAsExpected === true).length,
    allFaultsObserved: unverified.length === 0,
    cases,
  };
  writeJson(outputPath, result);
  return result;
}

if (require.main === module) {
  const [datasetDir, runDir, outputPath] = process.argv.slice(2);
  if (!datasetDir || !runDir || !outputPath) throw new Error('Usage: validate-rag-operational-run <dataset-dir> <run-dir> <output.json>');
  console.log(JSON.stringify(validate({ datasetDir, runDir, outputPath }), null, 2));
}

module.exports = { validate };
