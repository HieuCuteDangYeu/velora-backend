'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateConfig } = require('./validate-rabbitmq-config.cjs');

const valid = {
  RABBITMQ_URL: 'amqp://velora:secret@rabbitmq:5672/',
  RABBITMQ_DEFAULT_USER: 'velora',
  RABBITMQ_DEFAULT_PASS: 'secret',
  RABBITMQ_DEFAULT_VHOST: '/',
};

test('accepts the canonical username, password, vhost, and required keys', () => {
  assert.deepEqual(validateConfig(valid), { user: 'velora', vhost: '/' });
});

test('rejects a URL username mismatch without exposing values', () => {
  assert.throws(
    () =>
      validateConfig({
        ...valid,
        RABBITMQ_URL: 'amqp://guest:secret@rabbitmq:5672/',
      }),
    /username differs/,
  );
});

test('rejects a URL vhost mismatch', () => {
  assert.throws(
    () =>
      validateConfig({
        ...valid,
        RABBITMQ_URL: 'amqp://velora:secret@rabbitmq:5672/other',
      }),
    /vhost differs/,
  );
});

test('rejects a missing required key', () => {
  const values = { ...valid };
  delete values.RABBITMQ_DEFAULT_VHOST;
  assert.throws(
    () => validateConfig(values),
    /missing required key RABBITMQ_DEFAULT_VHOST/,
  );
});

test('rejects legacy username/password keys', () => {
  assert.throws(
    () => validateConfig({ ...valid, RABBITMQ_USER: 'velora' }),
    /dead key must be removed: RABBITMQ_USER/,
  );
});

test('rejects a URL password mismatch without printing either password', () => {
  assert.throws(
    () =>
      validateConfig({
        ...valid,
        RABBITMQ_URL: 'amqp://velora:other@rabbitmq:5672/',
      }),
    /password differs/,
  );
});
