#!/usr/bin/env node

'use strict';

const { spawnSync } = require('node:child_process');
const dotenv = require('dotenv');
const fs = require('node:fs');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '../..');
const evaluationRoot = path.join(repositoryRoot, 'eval/rag');
const mode = process.argv[2] ?? 'offline';
const forwarded = process.argv.slice(3);

if (mode === 'capacity-check') {
  dotenv.config({
    path:
      process.env.RAG_EVAL_ENV_FILE ||
      path.join(repositoryRoot, '.env.test.local'),
  });
}

const candidates = [
  process.env.UV_BIN,
  'uv',
  path.join(process.env.XDG_BIN_HOME ?? '', 'uv'),
].filter(Boolean);
const uv = candidates.find((candidate) => {
  if (candidate.includes(path.sep)) return fs.existsSync(candidate);
  return spawnSync(candidate, ['--version'], { stdio: 'ignore' }).status === 0;
});

const commands = {
  offline: ['run', 'rag-eval', 'offline'],
  live: ['run', 'rag-eval', 'live'],
  report: ['run', 'rag-eval', 'report'],
  compare: ['run', 'rag-eval', 'compare'],
  test: ['run', 'pytest', '-q'],
  'capacity-check': ['run', 'rag-eval', 'capacity-check', '--confirm-one-call'],
};
const command = commands[mode];
if (!command) {
  console.error(`Unknown RAG evaluation command: ${mode}`);
  process.exit(2);
}

const virtualEnvironmentCommand =
  mode === 'test'
    ? [path.join(evaluationRoot, '.venv/bin/pytest'), '-q']
    : mode === 'capacity-check'
      ? [
          path.join(evaluationRoot, '.venv/bin/rag-eval'),
          mode,
          '--confirm-one-call',
        ]
      : [path.join(evaluationRoot, '.venv/bin/rag-eval'), mode];
const executable = uv || virtualEnvironmentCommand[0];
const args = uv
  ? [...command, ...forwarded]
  : [...virtualEnvironmentCommand.slice(1), ...forwarded];
if (!fs.existsSync(executable) && executable.includes(path.sep)) {
  console.error(
    'uv or a synced eval/rag/.venv is required for RAG evaluation tooling.',
  );
  process.exit(2);
}

const result = spawnSync(executable, args, {
  cwd: evaluationRoot,
  env: {
    ...process.env,
    UV_CACHE_DIR:
      process.env.UV_CACHE_DIR || path.join(evaluationRoot, '.uv-cache'),
  },
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
