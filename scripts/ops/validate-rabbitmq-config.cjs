#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_KEYS = [
  'RABBITMQ_URL',
  'RABBITMQ_DEFAULT_USER',
  'RABBITMQ_DEFAULT_PASS',
  'RABBITMQ_DEFAULT_VHOST',
];
const DEAD_KEYS = ['RABBITMQ_USER', 'RABBITMQ_PASSWORD'];

function unquote(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    values[match[1]] = unquote(match[2].trim());
  }
  return values;
}

function normalizedVhost(value) {
  const decoded = decodeURIComponent(value || '/');
  if (decoded === '' || decoded === '/') return '/';
  return decoded.startsWith('/') ? decoded : `/${decoded}`;
}

function validateConfig(values) {
  for (const key of REQUIRED_KEYS) {
    if (!values[key]) throw new Error(`missing required key ${key}`);
  }

  for (const key of DEAD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      throw new Error(`dead key must be removed: ${key}`);
    }
  }

  let url;
  try {
    url = new URL(values.RABBITMQ_URL);
  } catch {
    throw new Error('RABBITMQ_URL is not a valid AMQP URL');
  }

  if (!['amqp:', 'amqps:'].includes(url.protocol)) {
    throw new Error('RABBITMQ_URL must use amqp or amqps');
  }
  if (!url.username || !url.password || !url.hostname || !url.port) {
    throw new Error(
      'RABBITMQ_URL must include username, password, host, and port',
    );
  }
  if (decodeURIComponent(url.username) !== values.RABBITMQ_DEFAULT_USER) {
    throw new Error('RABBITMQ_URL username differs from RABBITMQ_DEFAULT_USER');
  }
  if (decodeURIComponent(url.password) !== values.RABBITMQ_DEFAULT_PASS) {
    throw new Error('RABBITMQ_URL password differs from RABBITMQ_DEFAULT_PASS');
  }
  if (
    normalizedVhost(url.pathname) !==
    normalizedVhost(values.RABBITMQ_DEFAULT_VHOST)
  ) {
    throw new Error('RABBITMQ_URL vhost differs from RABBITMQ_DEFAULT_VHOST');
  }

  return {
    user: values.RABBITMQ_DEFAULT_USER,
    vhost: normalizedVhost(values.RABBITMQ_DEFAULT_VHOST),
  };
}

function main(argv = process.argv.slice(2)) {
  const fileIndex = argv.indexOf('--env-file');
  const envFile = fileIndex >= 0 ? argv[fileIndex + 1] : '.env';
  if (!envFile || envFile.startsWith('--')) {
    throw new Error('--env-file requires a path');
  }
  const values = parseEnv(fs.readFileSync(path.resolve(envFile), 'utf8'));
  const result = validateConfig(values);
  console.log(
    `RABBITMQ_CONFIG_VALID=YES USER=${result.user} VHOST=${result.vhost}`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`RABBITMQ_CONFIG_VALID=NO ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { parseEnv, validateConfig };
