'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  datasetItem,
  assertCompleteExperimentResult,
  assertBillingPeriodVerified,
  cachedToolCalls,
  assertToolObservationReadback,
  estimateLangfuseReplayUnits,
  loadRun,
  readBackToolObservations,
  replayCachedToolObservations,
  remoteExperimentExists,
  runExperiment,
  runMayStart,
} = require('./run-rag-langfuse-experiment.cjs');
const { fingerprint } = require('./rag-evaluation-contract.cjs');

test('Langfuse replay requires a fresh reset proof with enough billable headroom', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'langfuse-billing-proof-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const evidence = path.join(dir, 'billing.png');
  const proofPath = path.join(dir, 'phase-gates.json');
  const now = Date.parse('2026-10-29T12:00:00.000Z');
  fs.writeFileSync(evidence, 'read-only UI evidence');
  const proof = {
    schemaVersion: 'rag-remediation-phase-gate-status-v25',
    langfuseUsage: {
      billingPeriodVerified: true,
      resetObserved: true,
      usageAsOf: new Date(now).toISOString(),
      billingPeriodStart: '2026-10-29',
      billingPeriodEnd: '2026-11-29',
      currentBillingPeriodUnits: 1_000,
      hobbyMonthlyAllowance: 50_000,
      evidence,
    },
  };
  fs.writeFileSync(proofPath, JSON.stringify(proof));
  const args = {
    'billing-period-verified': true,
    'billing-proof': proofPath,
  };

  assert.doesNotThrow(() => assertBillingPeriodVerified(args, 20_000, now));
  assert.throws(
    () => assertBillingPeriodVerified({}, 20_000, now),
    /requires --billing-period-verified and --billing-proof/,
  );
  assert.throws(
    () => assertBillingPeriodVerified(args, 50_000, now),
    /available; replay requires an estimated/,
  );
  proof.langfuseUsage.resetObserved = false;
  fs.writeFileSync(proofPath, JSON.stringify(proof));
  assert.throws(
    () => assertBillingPeriodVerified(args, 20_000, now),
    /does not prove a reset/,
  );
  proof.langfuseUsage.resetObserved = true;
  proof.langfuseUsage.currentBillingPeriodUnits = 71_921;
  fs.writeFileSync(proofPath, JSON.stringify(proof));
  assert.throws(
    () => assertBillingPeriodVerified(args, 20_000, now),
    /stale, over limit/,
  );
});

test('Langfuse replay headroom estimate includes traces, tool observations and scores', () => {
  const rows = [{ id: 'case-1' }, { id: 'case-2' }];
  const cohort = {
    responses: new Map([
      [
        'case-1',
        {
          trace: {
            workflowMetrics: {
              diagnostics: {
                contextToolExecution: {
                  calls: [
                    { toolName: 'search_reel_content' },
                    { toolName: 'get_reel_context' },
                  ],
                },
              },
            },
          },
        },
      ],
      ['case-2', {}],
    ]),
    semantic: { 'case-1': { faithfulness: { score: 0.8 } } },
    deterministic: new Map([
      ['case-1', { exactMatch: 1 }],
      ['case-2', { answerContainment: 0.5 }],
    ]),
  };
  const run = {
    rows,
    datasetVersion: 'test-v1',
    cohorts: { baseline: cohort, candidate: cohort },
  };

  assert.equal(estimateLangfuseReplayUnits(run, ['baseline', 'candidate']), 39);
});

test('maximum V8 cached replay estimate fits the 50,000-unit hobby allowance', () => {
  const rows = Array.from({ length: 400 }, (_, index) => ({
    id: `case-${index}`,
  }));
  // RetrievalAgentPolicyAdapter bounds these settings to five steps and four calls.
  const maxToolCalls = 5 * 4;
  const semanticFields = [
    'faithfulness',
    'factualCorrectness',
    'responseRelevancy',
    'contextCompleteness',
  ];
  const deterministicFields = [
    'exactMatch',
    'answerContainment',
    'answerTokenF1',
    'generationEvidenceCoverage',
    'generationEvidenceCaptureCoverage',
    'citationSourceRecall',
    'retrieval_recall_at_5',
  ];
  const cohorts = {};
  for (const phase of ['baseline', 'candidate']) {
    const responses = new Map();
    const semantic = {};
    const deterministic = new Map();
    for (const row of rows) {
      const calls = Array.from({ length: maxToolCalls }, () => ({
        toolName: 'search_reel_content',
        status: 'COMPLETED',
      }));
      responses.set(row.id, {
        trace: {
          workflowMetrics: {
            diagnostics: { contextToolExecution: { calls } },
          },
        },
      });
      semantic[row.id] = Object.fromEntries(
        semanticFields.map((field) => [field, { score: 1 }]),
      );
      deterministic.set(
        row.id,
        Object.fromEntries(deterministicFields.map((field) => [field, 1])),
      );
    }
    cohorts[phase] = { responses, semantic, deterministic };
  }
  const estimate = estimateLangfuseReplayUnits(
    { rows, cohorts, datasetVersion: 'rag-coverage-v8' },
    ['baseline', 'candidate'],
  );

  assert.equal(estimate, 40_833);
  assert(estimate < 50_000);
});

test('cached dataset items retain the selected dataset version in their identity', () => {
  const row = {
    id: 'case-1',
    input: { question: 'Question?' },
    expectedOutput: { answer: 'Answer' },
  };
  const defaultItem = datasetItem(row, 'a'.repeat(64));
  const item = datasetItem(
    row,
    'a'.repeat(64),
    'rag-coverage-v8-frame-reviewed-20261027-01',
  );

  assert.match(defaultItem.id, /^rag-v7-/);
  assert.match(item.id, /^rag-v8-/);
  assert.equal(
    item.metadata.datasetVersion,
    'rag-coverage-v8-frame-reviewed-20261027-01',
  );
});

test('billing preflight validates the proof before creating any Langfuse client', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'langfuse-preflight-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const datasetDir = path.join(temp, 'dataset');
  const runDir = path.join(temp, 'run');
  const rows = [
    {
      id: 'case-development',
      input: { question: 'Development question?' },
      expectedOutput: { answer: 'Development answer' },
    },
    {
      id: 'case-held-out',
      input: { question: 'Held-out question?' },
      expectedOutput: { answer: 'Held-out answer' },
    },
  ];
  const datasetSha = fingerprint(rows);
  const writeJson = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  writeJson(path.join(datasetDir, 'manifest.json'), {
    datasetVersion: 'rag-coverage-v8-billing-preflight-test',
    datasetSha256: 'f'.repeat(64),
    caseCount: 440,
  });
  writeJson(path.join(datasetDir, 'development.json'), [rows[0]]);
  writeJson(path.join(datasetDir, 'held_out.json'), [rows[1]]);
  for (const phase of ['baseline', 'candidate']) {
    const cohortDir = path.join(runDir, `cohort-v8-${phase}`);
    writeJson(path.join(cohortDir, 'state.json'), {
      status: 'COMPLETE',
      datasetSha256: datasetSha,
      buildFingerprint: `build-${phase}`,
      cases: Object.fromEntries(
        rows.map((row) => [row.id, { status: 'COMPLETED' }]),
      ),
    });
    fs.writeFileSync(
      path.join(cohortDir, 'responses.jsonl'),
      `${rows.map((row) => JSON.stringify({ caseId: row.id })).join('\n')}\n`,
    );
  }
  const evidence = path.join(temp, 'billing.png');
  fs.writeFileSync(evidence, 'local read-only proof fixture');
  const now = new Date();
  const start = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const endDate = new Date(now.getTime() + 30 * 86_400_000);
  const proofPath = path.join(temp, 'billing-proof.json');
  const proof = {
    schemaVersion: 'rag-remediation-phase-gate-status-test',
    langfuseUsage: {
      billingPeriodVerified: true,
      resetObserved: true,
      usageAsOf: now.toISOString(),
      billingPeriodStart: start,
      billingPeriodEnd: endDate.toISOString().slice(0, 10),
      currentBillingPeriodUnits: 0,
      hobbyMonthlyAllowance: 50_000,
      evidence,
    },
  };
  writeJson(proofPath, proof);
  const script = path.join(__dirname, 'run-rag-langfuse-experiment.cjs');
  const args = [
    script,
    '--billing-preflight',
    '--billing-period-verified',
    '--billing-proof',
    proofPath,
    '--dataset-dir',
    datasetDir,
    '--run-dir',
    runDir,
    '--cohort-prefix',
    'cohort-v8',
    '--allow-nonpassing-quality',
  ];
  const valid = spawnSync(process.execPath, args, {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf8',
  });
  assert.equal(valid.status, 0, valid.stderr);
  const outputLine = valid.stdout
    .trim()
    .split(/\r?\n/)
    .find((line) => line.startsWith('{'));
  assert.ok(outputLine);
  assert.deepEqual(JSON.parse(outputLine), {
    status: 'BILLING_PROOF_PASS',
    requiredHeadroomUnits: 12,
  });

  proof.langfuseUsage.currentBillingPeriodUnits = 50_000;
  writeJson(proofPath, proof);
  const overLimit = spawnSync(process.execPath, args, {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf8',
  });
  assert.notEqual(overLimit.status, 0);
  assert.match(overLimit.stderr, /stale, over limit/);
});

test('V8 loader keeps the 400-case primary hash distinct from its 440-case artifact', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-langfuse-v8-'));
  const datasetDir = path.join(root, 'dataset');
  const runDir = path.join(root, 'run');
  const rows = [
    {
      id: 'case-development',
      input: { question: 'Development question?' },
      expectedOutput: { answer: 'Development answer' },
    },
    {
      id: 'case-held-out',
      input: { question: 'Held-out question?' },
      expectedOutput: { answer: 'Held-out answer' },
    },
  ];
  const primaryHash = fingerprint(rows);
  const manifestHash = 'f'.repeat(64);
  const writeJson = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };

  try {
    writeJson(path.join(datasetDir, 'manifest.json'), {
      datasetVersion: 'rag-coverage-v8-frame-reviewed-20261027-01',
      datasetSha256: manifestHash,
      caseCount: 440,
    });
    writeJson(path.join(datasetDir, 'development.json'), [rows[0]]);
    writeJson(path.join(datasetDir, 'held_out.json'), [rows[1]]);

    for (const phase of ['baseline', 'candidate']) {
      const cohortDir = path.join(runDir, `cohort-v8-${phase}`);
      writeJson(path.join(cohortDir, 'state.json'), {
        status: 'COMPLETE',
        datasetSha256: primaryHash,
        buildFingerprint: `build-${phase}`,
        cases: Object.fromEntries(
          rows.map((row) => [row.id, { status: 'COMPLETED' }]),
        ),
      });
      fs.writeFileSync(
        path.join(cohortDir, 'responses.jsonl'),
        `${rows.map((row) => JSON.stringify({ caseId: row.id })).join('\n')}\n`,
      );
    }

    const run = loadRun(datasetDir, runDir, {
      cohortPrefix: 'cohort-v8',
      allowNonpassingQuality: true,
    });

    assert.equal(
      run.datasetVersion,
      'rag-coverage-v8-frame-reviewed-20261027-01',
    );
    assert.equal(run.rows.length, 2);
    assert.equal(run.datasetSha256, primaryHash);
    assert.notEqual(run.datasetSha256, run.sourceManifestSha256);
    assert.equal(run.sourceManifestSha256, manifestHash);
    assert.equal(run.sourceArtifactCaseCount, 440);
    assert.equal(run.cohorts.candidate.responses.size, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('replay starts only when neither ledger nor remote experiment is ambiguous', () => {
  assert.equal(runMayStart(undefined, false), true);
  assert.equal(
    runMayStart({ status: 'COMPLETE', datasetRunId: 'run-1' }, false),
    false,
  );
  assert.throws(
    () => runMayStart({ status: 'IN_PROGRESS' }, false),
    /reconcile it/,
  );
  assert.throws(() => runMayStart(undefined, true), /reconcile it/);
});

test('remote replay guard fails closed if Langfuse experiment history is unavailable', async () => {
  const requests = [];
  const client = {
    api: {
      experiments: {
        list: async (query) => {
          requests.push(query);
          return { data: [{ name: 'run-1' }] };
        },
      },
    },
  };

  assert.equal(await remoteExperimentExists(client, 'run-1'), true);
  assert.equal(await remoteExperimentExists(client, 'run-2'), false);
  assert.equal(requests[0].name, 'run-1');
  await assert.rejects(
    remoteExperimentExists(
      { api: { experiments: { list: async () => ({}) } } },
      'run-3',
    ),
    /refusing replay/,
  );
});

test('a Langfuse run is complete only when every case shares its linked dataset run', () => {
  const items = [
    { metadata: { caseId: 'case-1' } },
    { metadata: { caseId: 'case-2' } },
  ];
  const result = {
    datasetRunId: 'run-1',
    itemResults: items.map((item, index) => ({
      item,
      datasetRunId: 'run-1',
      traceId: `trace-${index + 1}`,
    })),
  };

  assert.doesNotThrow(() =>
    assertCompleteExperimentResult(result, items, 'candidate'),
  );
  assert.throws(
    () =>
      assertCompleteExperimentResult(
        { ...result, itemResults: result.itemResults.slice(0, 1) },
        items,
        'candidate',
      ),
    /did not link every item/,
  );
  assert.throws(
    () =>
      assertCompleteExperimentResult(
        {
          ...result,
          itemResults: [
            { ...result.itemResults[0], datasetRunId: 'other' },
            result.itemResults[1],
          ],
        },
        items,
        'candidate',
      ),
    /did not link every item/,
  );
  assert.throws(
    () =>
      assertCompleteExperimentResult(
        {
          ...result,
          itemResults: result.itemResults.map((item) => ({
            ...item,
            traceId: undefined,
          })),
        },
        items,
        'candidate',
      ),
    /did not link every item/,
  );
  assert.throws(
    () =>
      assertCompleteExperimentResult(
        {
          ...result,
          itemResults: result.itemResults.map((item) => ({
            ...item,
            traceId: 'trace-1',
          })),
        },
        items,
        'candidate',
      ),
    /did not link every item/,
  );
});

test('tool observation readback proves exact names under each Langfuse trace', () => {
  const expected = new Map([
    ['trace-1', ['search_reel_content', 'get_reel_context']],
    ['trace-2', []],
  ]);
  const observations = [
    { traceId: 'trace-1', type: 'CHAIN', environment: 'rag-evaluation' },
    {
      traceId: 'trace-1',
      type: 'TOOL',
      name: 'get_reel_context',
      environment: 'rag-evaluation',
    },
    {
      traceId: 'trace-1',
      type: 'TOOL',
      name: 'search_reel_content',
      environment: 'rag-evaluation',
    },
    { traceId: 'trace-2', type: 'SPAN', environment: 'rag-evaluation' },
  ];

  assert.equal(assertToolObservationReadback(observations, expected), 2);
  assert.throws(
    () =>
      assertToolObservationReadback(
        observations.filter((item) => item.name !== 'get_reel_context'),
        expected,
      ),
    /LANGFUSE_TOOL_READBACK_INCOMPLETE/,
  );
});

test('reads persisted TOOL observations back across Langfuse pages', async () => {
  const items = [
    { metadata: { caseId: 'case-1' } },
    { metadata: { caseId: 'case-2' } },
  ];
  const responses = new Map([
    [
      'case-1',
      {
        trace: {
          workflowMetrics: {
            diagnostics: {
              contextToolExecution: {
                calls: [
                  { toolName: 'search_reel_content' },
                  { toolName: 'get_reel_context' },
                ],
              },
            },
          },
        },
      },
    ],
    ['case-2', {}],
  ]);
  const pages = [
    {
      data: [
        {
          id: 'root-1',
          traceId: 'trace-1',
          type: 'CHAIN',
          environment: 'rag-evaluation',
        },
        {
          id: 'tool-1',
          traceId: 'trace-1',
          type: 'TOOL',
          name: 'search_reel_content',
          environment: 'rag-evaluation',
        },
        {
          id: 'root-2',
          traceId: 'trace-2',
          type: 'SPAN',
          environment: 'rag-evaluation',
        },
      ],
      meta: { cursor: 'page-2' },
    },
    {
      data: [
        {
          id: 'tool-2',
          traceId: 'trace-1',
          type: 'TOOL',
          name: 'get_reel_context',
          environment: 'rag-evaluation',
        },
      ],
      meta: {},
    },
  ];
  const queries = [];
  const client = {
    api: {
      observations: {
        getMany: async (query) => {
          queries.push(query);
          return pages.shift();
        },
      },
    },
  };

  assert.equal(
    await readBackToolObservations(
      client,
      items.map((item, index) => ({ item, traceId: `trace-${index + 1}` })),
      responses,
      { fromStartTime: '2026-10-29T00:00:00.000Z', retryDelaysMs: [0] },
    ),
    2,
  );
  assert.equal(queries.length, 2);
  assert.equal(queries[0].environment, 'rag-evaluation');
  assert.equal(queries[0].fromStartTime, '2026-10-29T00:00:00.000Z');
  assert.equal(typeof queries[0].toStartTime, 'string');
  assert.equal(queries[0].fields, 'core,basic');
  assert.equal(queries[1].cursor, 'page-2');
});

test('retries observation readback when tool spans are not visible yet', async () => {
  const item = { metadata: { caseId: 'case-1' } };
  const pages = [
    {
      data: [
        {
          id: 'root-1',
          traceId: 'trace-1',
          type: 'CHAIN',
          environment: 'rag-evaluation',
        },
      ],
      meta: {},
    },
    {
      data: [
        {
          id: 'root-1',
          traceId: 'trace-1',
          type: 'CHAIN',
          environment: 'rag-evaluation',
        },
        {
          id: 'tool-1',
          traceId: 'trace-1',
          type: 'TOOL',
          name: 'search_reel_content',
          environment: 'rag-evaluation',
        },
      ],
      meta: {},
    },
  ];
  let calls = 0;
  const client = {
    api: {
      observations: {
        getMany: async () => {
          calls += 1;
          return pages.shift();
        },
      },
    },
  };

  assert.equal(
    await readBackToolObservations(
      client,
      [{ item, traceId: 'trace-1' }],
      new Map([
        [
          'case-1',
          {
            trace: {
              workflowMetrics: {
                diagnostics: {
                  contextToolExecution: {
                    calls: [{ toolName: 'search_reel_content' }],
                  },
                },
              },
            },
          },
        ],
      ]),
      { fromStartTime: '2026-10-29T00:00:00.000Z', retryDelaysMs: [0, 0] },
    ),
    1,
  );
  assert.equal(calls, 2);
});

test('rejects repeated observation API cursors during tool readback', async () => {
  const client = {
    api: {
      observations: {
        getMany: async () => ({ data: [], meta: { cursor: 'same-cursor' } }),
      },
    },
  };

  await assert.rejects(
    readBackToolObservations(
      client,
      [{ item: { metadata: { caseId: 'case-1' } }, traceId: 'trace-1' }],
      new Map([['case-1', {}]]),
      { fromStartTime: '2026-10-29T00:00:00.000Z', retryDelaysMs: [0] },
    ),
    /LANGFUSE_TOOL_READBACK_INVALID repeated cursor/,
  );
});

test('experiment ledger uses API readback counts rather than attempted tool writes', async () => {
  const item = { metadata: { caseId: 'case-1' } };
  const response = {
    output: { answer: 'Answer', citations: [] },
    trace: {
      workflowMetrics: {
        diagnostics: {
          contextToolExecution: {
            calls: [{ toolName: 'search_reel_content', status: 'SUCCESS' }],
          },
        },
      },
    },
  };
  let forceFlushed = false;
  let clientFlushed = false;
  const client = {
    api: {
      observations: {
        getMany: async () => ({
          data: [
            {
              id: 'root-1',
              traceId: 'trace-1',
              type: 'CHAIN',
              environment: 'rag-evaluation',
            },
            {
              id: 'tool-1',
              traceId: 'trace-1',
              type: 'TOOL',
              name: 'search_reel_content',
              environment: 'rag-evaluation',
            },
          ],
          meta: {},
        }),
      },
    },
    flush: async () => {
      clientFlushed = true;
    },
  };
  const dataset = {
    items: [item],
    runExperiment: async (options) => {
      const output = await options.task({ metadata: item.metadata });
      return {
        runName: 'RAG V8 baseline cached replay',
        datasetRunId: 'run-1',
        datasetRunUrl: 'https://langfuse.example/run-1',
        experimentId: 'experiment-1',
        itemResults: [
          {
            item,
            output,
            evaluations: [],
            traceId: 'trace-1',
            datasetRunId: 'run-1',
          },
        ],
        runEvaluations: [],
      };
    },
  };
  const result = await runExperiment(
    client,
    dataset,
    'baseline',
    {
      state: { buildFingerprint: 'b'.repeat(64) },
      responses: new Map([['case-1', response]]),
      semantic: {},
      deterministic: new Map(),
    },
    {
      runName: 'RAG V8 baseline cached replay',
      items: [item],
      datasetSha256: 'a'.repeat(64),
      datasetVersion: 'rag-coverage-v8',
      primaryCaseCount: 1,
      sourceArtifactCaseCount: 1,
      sourceManifestSha256: 'c'.repeat(64),
      evaluatorVersion: 'test-evaluator',
      qualityGate: 'NOT_AVAILABLE',
      startActiveObservation: async (_name, callback) =>
        callback({ update: () => {} }),
      spanProcessor: {
        forceFlush: async () => {
          forceFlushed = true;
        },
      },
    },
  );

  assert.equal(forceFlushed, true);
  assert.equal(clientFlushed, true);
  assert.equal(result.toolObservationCount, 1);
  assert.equal(result.toolObservationsReadBack, true);
});

test('cached replay exposes only persisted tool names and safe result metadata', () => {
  const calls = cachedToolCalls({
    trace: {
      workflowMetrics: {
        diagnostics: {
          contextToolExecution: {
            calls: [
              {
                toolName: 'search_reel_content',
                status: 'SUCCESS',
                itemCount: 2,
                latencyMs: 12,
                arguments: { query: 'private text' },
              },
              {
                toolName: 'unsafe tool name',
                status: 'ERROR',
              },
            ],
          },
        },
      },
    },
  });

  assert.deepEqual(calls, [
    {
      name: 'search_reel_content',
      status: 'SUCCESS',
      itemCount: 2,
      latencyMs: 12,
    },
    {
      name: 'unknown_tool',
      status: 'ERROR',
      itemCount: null,
      latencyMs: null,
    },
  ]);
  assert.equal(JSON.stringify(calls).includes('private text'), false);
});

test('cached replay creates nested Langfuse tool observations tagged as replay', async () => {
  const observations = [];
  const startActiveObservation = async (name, callback, options) => {
    const record = { name, options, updates: [] };
    observations.push(record);
    await callback({ update: (value) => record.updates.push(value) });
  };

  const emitted = await replayCachedToolObservations(
    {
      trace: {
        workflowMetrics: {
          diagnostics: {
            contextToolExecution: {
              calls: [
                {
                  toolName: 'search_reel_content',
                  status: 'SUCCESS',
                  itemCount: 1,
                  latencyMs: 7,
                },
              ],
            },
          },
        },
      },
    },
    startActiveObservation,
    { phase: 'candidate', datasetSha256: 'a'.repeat(64) },
  );

  assert.equal(emitted, 1);
  assert.equal(observations[0].name, 'rag.cached-response-replay');
  assert.equal(observations[0].options.asType, 'chain');
  assert.equal(observations[1].name, 'search_reel_content');
  assert.equal(observations[1].options.asType, 'tool');
  assert.equal(
    observations[1].updates[0].metadata.sourceMode,
    'PERSISTED_CACHED_RESPONSE',
  );
  assert.deepEqual(observations[1].updates[0].output, {
    status: 'SUCCESS',
    itemCount: 1,
    originalLatencyMs: 7,
  });
});
