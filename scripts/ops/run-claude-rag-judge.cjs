#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const model = 'claude-haiku-5-5';

function schemaFor(dimension) {
  return {
    type: 'object',
    additionalProperties: false,
    required: [dimension],
    properties: {
      [dimension]: {
        type: 'object',
        additionalProperties: false,
        required: ['score', 'reasoning'],
        properties: {
          score: { type: 'number', minimum: 0, maximum: 1 },
          reasoning: { type: 'string', maxLength: 500 },
        },
      },
    },
  };
}

function claudeEnvironment() {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TERM: 'dumb',
    NO_COLOR: '1',
  };
  for (const key of [
    'CLAUDE_CONFIG_DIR',
    'SSL_CERT_FILE',
    'NODE_EXTRA_CA_CERTS',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function installedClaudeVersion() {
  const version = spawnSync('claude', ['--version'], {
    encoding: 'utf8',
    env: claudeEnvironment(),
    maxBuffer: 1024 * 1024,
  });
  if (version.status !== 0 || !version.stdout?.trim())
    throw new Error('Unable to determine the installed Claude Code version');
  return version.stdout.trim();
}

// A tool-less, settings-less, non-persistent print session keeps the judge a
// pure prompt -> structured score call with no hooks, skills or file access.
function runClaudeDimension(dimension, prompt) {
  const run = spawnSync(
    'claude',
    [
      '-p',
      '--model',
      model,
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(schemaFor(dimension)),
      '--no-session-persistence',
      '--disable-slash-commands',
      '--tools',
      '',
      '--setting-sources',
      '',
    ],
    {
      env: claudeEnvironment(),
      input: prompt,
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  if (run.error) throw run.error;
  let envelope;
  try {
    envelope = JSON.parse(run.stdout);
  } catch {
    envelope = undefined;
  }
  if (run.status !== 0 || envelope?.is_error)
    throw new Error(
      `Claude judge failed with exit ${run.status}: ${String(envelope?.result ?? run.stderr ?? '').slice(0, 200)}`,
    );
  const result = envelope?.structured_output?.[dimension];
  if (
    !result ||
    typeof result.score !== 'number' ||
    result.score < 0 ||
    result.score > 1 ||
    typeof result.reasoning !== 'string'
  )
    throw new Error(`Claude judge returned an invalid ${dimension} score`);
  return result;
}

module.exports = {
  claudeEnvironment,
  installedClaudeVersion,
  model,
  runClaudeDimension,
};
