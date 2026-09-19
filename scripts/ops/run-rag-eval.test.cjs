'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('live mode loads the forwarded env file before launching the evaluator', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-eval-runner-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const envFile = path.join(directory, 'eval.env');
  const captureFile = path.join(directory, 'capture.txt');
  const fakeUv = path.join(directory, 'uv');
  fs.writeFileSync(envFile, 'RAG_EVAL_RUNNER_SENTINEL=loaded\n');
  fs.writeFileSync(
    fakeUv,
    '#!/bin/sh\nprintf "%s\\n" "$RAG_EVAL_RUNNER_SENTINEL" > "$RUNNER_CAPTURE_FILE"\nexit 0\n',
    { mode: 0o755 },
  );
  const env = { ...process.env };
  delete env.RAG_EVAL_RUNNER_SENTINEL;

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, 'run-rag-eval.cjs'), 'live', '--env-file', envFile],
    {
      env: {
        ...env,
        UV_BIN: fakeUv,
        RUNNER_CAPTURE_FILE: captureFile,
      },
      encoding: 'utf-8',
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(captureFile, 'utf-8').trim(), 'loaded');
});
