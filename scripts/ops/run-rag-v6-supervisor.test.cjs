'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { cohortAction } = require('./run-rag-v6-supervisor.cjs');

const now = Date.parse('2026-10-28T00:02:00.000Z');

test('waits while the UTC quota reset is still in the future', () => {
  assert.equal(
    cohortAction(
      {
        status: 'WAITING_FOR_UTC_RESET',
        nextResumeAt: '2026-10-29T00:01:30.000Z',
      },
      now,
    ),
    'WAIT_FOR_RESET',
  );
});

test('re-enters the runner after reset while preserving completed case attempts', () => {
  const state = {
    status: 'WAITING_FOR_UTC_RESET',
    nextResumeAt: '2026-10-28T00:01:30.000Z',
    cases: {
      completed: { status: 'COMPLETED', attemptCount: 1 },
      pending: { status: 'PENDING', attemptCount: 0 },
    },
  };

  assert.equal(cohortAction(state, now), 'RUNNER');
  assert.equal(state.cases.completed.attemptCount, 1);
  assert.equal(state.cases.pending.attemptCount, 0);
});

test('does not re-run terminal cohorts', () => {
  assert.equal(
    cohortAction(
      { status: 'COMPLETE_WITH_EXECUTION_FAILURES', cases: {} },
      now,
    ),
    'COMPLETE',
  );
});

test('keeps provider or execution halts blocked', () => {
  assert.equal(
    cohortAction({ status: 'HALTED_PROVIDER_OR_EXECUTION', cases: {} }, now),
    'HALTED',
  );
});

test('refuses to resume unresolved in-flight work', () => {
  assert.throws(
    () =>
      cohortAction(
        {
          status: 'WAITING_FOR_UTC_RESET',
          cases: { inFlight: { status: 'IN_FLIGHT' } },
        },
        now,
      ),
    /unresolved IN_FLIGHT/,
  );
});

test('rejects a quota wait without a valid resume timestamp', () => {
  assert.throws(
    () => cohortAction({ status: 'WAITING_FOR_UTC_RESET', cases: {} }, now),
    /valid nextResumeAt/,
  );
});
