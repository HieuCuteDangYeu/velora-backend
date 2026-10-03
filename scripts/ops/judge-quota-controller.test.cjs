'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { JudgeQuotaController } = require('./judge-quota-controller.cjs');

function tempLedger() {
  const directory = mkdtempSync(join(tmpdir(), 'velora-judge-cjs-'));
  return { directory, path: join(directory, 'ledger.jsonl') };
}

test('JudgeQuotaController CJS - reuses completed request without re-invoking', async (t) => {
  const ledger = tempLedger();
  t.after(() => rmSync(ledger.directory, { recursive: true, force: true }));

  const controller = new JudgeQuotaController({
    tpmLimit: 100,
    ledgerPath: ledger.path,
  });
  let calls = 0;
  const res1 = await controller.run('request-1', 10, async () => {
    calls += 1;
    return { value: 1 };
  });
  assert.deepEqual(res1, { value: 1 });

  const res2 = await controller.run('request-1', 10, async () => {
    calls += 1;
    return { value: 2 };
  });
  assert.deepEqual(res2, { value: 1 });
  assert.equal(calls, 1);
});

test('JudgeQuotaController CJS - fails closed on daily budget limit', async (t) => {
  const ledger = tempLedger();
  t.after(() => rmSync(ledger.directory, { recursive: true, force: true }));

  const controller = new JudgeQuotaController({
    tpmLimit: 100,
    tpdLimit: 5,
    ledgerPath: ledger.path,
  });
  let called = false;
  await assert.rejects(
    async () => {
      await controller.run('request-1', 6, async () => {
        called = true;
      });
    },
    (err) => err?.code === 'JUDGE_TPD_EXHAUSTED',
  );
  assert.equal(called, false);
});

test('JudgeQuotaController CJS - retries transient errors within bounds', async (t) => {
  const ledger = tempLedger();
  t.after(() => rmSync(ledger.directory, { recursive: true, force: true }));

  const sleeps = [];
  const controller = new JudgeQuotaController({
    tpmLimit: 100,
    ledgerPath: ledger.path,
    maxRetries: 1,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  let calls = 0;
  const result = await controller.run('request-1', 10, async () => {
    calls += 1;
    if (calls === 1) {
      throw Object.assign(new Error('rate limited'), { status: 429 });
    }
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [1000]);
});

test('JudgeQuotaController CJS - paces reservations against rolling TPM window', async (t) => {
  const ledger = tempLedger();
  t.after(() => rmSync(ledger.directory, { recursive: true, force: true }));

  let now = 0;
  const sleeps = [];
  const controller = new JudgeQuotaController({
    tpmLimit: 10,
    ledgerPath: ledger.path,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });

  await controller.run('request-1', 6, async () => 'first');
  await controller.run('request-2', 6, async () => 'second');
  assert.equal(sleeps[0], 60000);
});
