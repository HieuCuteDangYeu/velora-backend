'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildFingerprint,
  compiledRuntimeFiles,
} = require('./run-rag-coverage-evaluation.cjs');

test('compiled build fingerprint covers AI adapters and shared runtime libraries', () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'rag-build-fingerprint-'),
  );
  const runtimeRoot = path.join(temporaryRoot, 'dist', 'apps', 'ai-service');
  const compiledBase = path.join(runtimeRoot, 'apps', 'ai-service', 'src');
  const useCase = path.join(
    compiledBase,
    'application',
    'use-cases',
    'answer.js',
  );
  const adapter = path.join(
    compiledBase,
    'infrastructure',
    'adapters',
    'retrieval.js',
  );
  const common = path.join(
    runtimeRoot,
    'libs',
    'common',
    'src',
    'semantic-index.js',
  );

  try {
    for (const file of [useCase, adapter, common]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${path.basename(file)} v1`);
    }

    const compiledFiles = compiledRuntimeFiles(compiledBase);
    assert.deepEqual(
      compiledFiles.map(([relativePath]) => relativePath),
      [
        'apps/ai-service/src/application/use-cases/answer.js',
        'apps/ai-service/src/infrastructure/adapters/retrieval.js',
        'libs/common/src/semantic-index.js',
      ],
    );

    const initial = buildFingerprint(compiledBase);
    fs.writeFileSync(adapter, 'retrieval v2');
    const adapterChanged = buildFingerprint(compiledBase);
    fs.writeFileSync(common, 'semantic-index v2');
    const commonChanged = buildFingerprint(compiledBase);

    assert.notEqual(adapterChanged, initial);
    assert.notEqual(commonChanged, adapterChanged);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
