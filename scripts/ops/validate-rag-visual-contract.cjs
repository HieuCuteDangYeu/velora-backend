'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function validate({ datasetDir, outputPath }) {
  const rows = ['development', 'held_out'].flatMap((split) => readJson(path.join(datasetDir, `${split}.json`)));
  const fixtures = Object.assign({}, ...['development', 'held_out'].map((split) => readJson(path.join(datasetDir, `${split}-fixtures.json`))));
  const visualRows = rows.filter((row) => (row.expectedOutput?.relevantEvidenceIds || []).some((id) => id.includes(':visual:')));
  const failures = [];
  let evidenceCount = 0;
  for (const row of visualRows) {
    const fixture = fixtures[row.id] || {};
    const byId = new Map((fixture.scenes || []).map((scene) => [scene.id, scene]));
    const timestamp = row.input.question.match(/frame at (\d+(?:\.\d+)?) seconds/i)?.[1];
    for (const evidenceId of row.expectedOutput.relevantEvidenceIds.filter((id) => id.includes(':visual:'))) {
      evidenceCount += 1;
      const scene = byId.get(evidenceId);
      const evidenceText = scene && [scene.evidenceText, scene.retrievalText, scene.caption, scene.ocrText, ...(scene.objects || [])].filter(Boolean).join(' ').trim();
      const sceneTime = scene?.startTime ?? (typeof scene?.timestampMs === 'number' ? scene.timestampMs / 1000 : undefined);
      const issues = [];
      if (!scene) issues.push('MISSING_SCENE');
      if (scene && !evidenceText) issues.push('EMPTY_VISUAL_EVIDENCE');
      if (scene && scene.evidenceType && scene.evidenceType !== 'VISUAL') issues.push('WRONG_EVIDENCE_TYPE');
      if (scene && !scene.indexAttemptId) issues.push('MISSING_INDEX_ATTEMPT');
      if (scene && scene.indexVersion !== 'reel-index-v2') issues.push('STALE_INDEX_VERSION');
      if (scene && scene.embeddingModel !== 'BAAI/bge-m3') issues.push('WRONG_EMBEDDING_MODEL');
      if (scene && scene.embeddingVersion !== 'bge-m3-tei-v1') issues.push('WRONG_EMBEDDING_VERSION');
      if (scene && scene.embeddingDimensions !== 1024) issues.push('WRONG_EMBEDDING_DIMENSIONS');
      if (timestamp !== undefined && (sceneTime === undefined || Math.abs(Number(timestamp) - sceneTime) > 0.01)) issues.push('TIMESTAMP_MISMATCH');
      if (issues.length) failures.push({ caseId: row.id, evidenceId, issues });
    }
  }
  const result = {
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    datasetDir,
    cases: rows.length,
    casesWithVisualEvidence: visualRows.length,
    visualEvidenceItems: evidenceCount,
    failures,
    note: 'This validates frozen visual-source identity, timestamps, evidence text, and embedding/index provenance. It does not establish image truth or provider-backed caption quality.',
  };
  writeJson(outputPath, result);
  return result;
}

if (require.main === module) {
  const [datasetDir, outputPath] = process.argv.slice(2);
  if (!datasetDir || !outputPath) throw new Error('Usage: validate-rag-visual-contract <dataset-dir> <output.json>');
  console.log(JSON.stringify(validate({ datasetDir, outputPath }), null, 2));
}

module.exports = { validate };
