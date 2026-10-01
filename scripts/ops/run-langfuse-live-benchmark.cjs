#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const DATASET_NAME = 'velora/rag-scraped-v1-provisional';
const TARGET_CASES = 220;
const BOT_USER_ID =
  process.env.BOT_USER_ID || 'b6ddf921-c87c-4f68-8d71-f1b1fd33f3e7';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value?.startsWith('--')) continue;
    const [name, inlineValue] = value.slice(2).split('=', 2);
    const next = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined && next && !next.startsWith('--')) index += 1;
    args[name] = inlineValue ?? next ?? true;
  }
  return args;
}

function nowRunId() {
  return `langfuse-live-220-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalize(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function tokens(value) {
  return normalize(value).match(/[a-z0-9]+/g) ?? [];
}

function tokenRecall(expected, actual) {
  const expectedTokens = tokens(expected);
  if (!expectedTokens.length) return 1;
  const actualSet = new Set(tokens(actual));
  return (
    expectedTokens.filter((token) => actualSet.has(token)).length /
    expectedTokens.length
  );
}

function citationEvidenceIds(citations) {
  if (!Array.isArray(citations)) return [];
  return [
    ...new Set(
      citations
        .flatMap((citation) => [
          citation?.evidenceId,
          citation?.sourceId,
          citation?.chunkId,
          citation?.id,
          typeof citation?.reelId === 'string' && citation.reelId
            ? `reel:${citation.reelId}`
            : null,
        ])
        .filter((value) => typeof value === 'string' && value.trim()),
    ),
  ];
}

function deterministicEvaluations(input, expectedOutput, output) {
  const expectedAnswer = expectedOutput?.answer ?? '';
  const actualAnswer = output?.answer ?? '';
  const expectedEvidence = new Set(
    expectedOutput?.evidenceIds ?? input?.evidenceIds ?? [],
  );
  const actualEvidence = citationEvidenceIds(output?.citations);
  const actualEvidenceSet = new Set(actualEvidence);
  const citations = Array.isArray(output?.citations) ? output.citations : [];
  const expectedModality = expectedOutput?.modality ?? input?.modality;

  const matchedEvidence = Array.from(expectedEvidence).filter((id) => {
    if (actualEvidenceSet.has(id)) return true;
    if (id.startsWith('reel:')) {
      const reelId = id.split(':')[1];
      return citations.some(
        (citation) =>
          citation?.reelId === reelId &&
          (!expectedModality ||
            !citation?.evidenceType ||
            citation.evidenceType === expectedModality),
      );
    }
    return false;
  });
  const expectedReelId = expectedOutput?.reelIds?.[0] ?? input?.reelIds?.[0];
  const citedReels = new Set(
    citations
      .map((citation) => citation?.reelId)
      .filter((value) => typeof value === 'string' && value),
  );
  const modalities = new Set(
    citations
      .map((citation) => citation?.evidenceType)
      .filter((value) => typeof value === 'string' && value),
  );
  return [
    {
      name: 'answer_exact_match',
      value: normalize(expectedAnswer) === normalize(actualAnswer) ? 1 : 0,
      dataType: 'NUMERIC',
    },
    {
      name: 'answer_token_recall',
      value: tokenRecall(expectedAnswer, actualAnswer),
      dataType: 'NUMERIC',
    },
    {
      name: 'evidence_recall',
      value: expectedEvidence.size
        ? matchedEvidence.length / expectedEvidence.size
        : 1,
      dataType: 'NUMERIC',
    },
    {
      name: 'reel_citation_match',
      value: expectedReelId && citedReels.has(expectedReelId) ? 1 : 0,
      dataType: 'NUMERIC',
    },
    {
      name: 'modality_match',
      value: expectedModality && modalities.has(expectedModality) ? 1 : 0,
      dataType: 'NUMERIC',
    },
  ];
}

function aggregateEvaluations(cases) {
  const values = new Map();
  for (const item of cases) {
    for (const evaluation of deterministicEvaluations(
      item.input,
      item.expectedOutput,
      item.output,
    )) {
      const current = values.get(evaluation.name) ?? [];
      current.push(evaluation.value);
      values.set(evaluation.name, current);
    }
  }
  return Object.fromEntries(
    [...values.entries()].map(([name, scores]) => [
      name,
      scores.reduce((sum, value) => sum + value, 0) / scores.length,
    ]),
  );
}

const RETRYABLE_FAILURE_CATEGORIES = new Set([
  'TEI_RERANKER_OVERLOADED',
  'TEI_RERANKER_PAYLOAD_FIXED',
  'GROQ_RATE_LIMITED',
  'PROVIDER_RATE_LIMITED',
]);
const EXCLUSION_REASONS = new Set([
  'CONVERSATION_DB_IO_TIMEOUT',
  'RAG_RESPONSE_TIMEOUT_UNRESOLVED',
]);
const MAX_CASE_RETRIES = 3;

function prepareInFlightRetry(state, caseId, failureCategory) {
  if (!RETRYABLE_FAILURE_CATEGORIES.has(failureCategory)) {
    throw new Error(`failure category is not retryable: ${failureCategory}`);
  }
  const current = state.cases[caseId];
  if (!current || current.status !== 'IN_FLIGHT') {
    throw new Error(`case ${caseId} is not IN_FLIGHT`);
  }
  if ((current.retryCount ?? 0) >= MAX_CASE_RETRIES) {
    throw new Error(`case ${caseId} exhausted its bounded retries`);
  }
  return {
    ...state,
    cases: {
      ...state.cases,
      [caseId]: {
        status: 'PENDING',
        attemptCount: current.attemptCount ?? 1,
        retryCount: (current.retryCount ?? 0) + 1,
        attemptHistory: [
          ...(current.attemptHistory ?? []),
          {
            status: 'FAILED_RECONCILED',
            failureCategory,
            conversationId: current.conversationId,
            userMessageId: current.userMessageId,
            requestStartedAt: current.requestStartedAt,
            reconciledAt: new Date().toISOString(),
          },
        ],
      },
    },
  };
}

function excludeInFlightCase(state, caseId, exclusionReason) {
  if (!EXCLUSION_REASONS.has(exclusionReason)) {
    throw new Error(`unsupported exclusion reason: ${exclusionReason}`);
  }
  const current = state.cases[caseId];
  if (!current || current.status !== 'IN_FLIGHT') {
    throw new Error(`case ${caseId} is not IN_FLIGHT`);
  }
  return {
    ...state,
    cases: {
      ...state.cases,
      [caseId]: {
        ...current,
        status: 'EXCLUDED',
        exclusionReason,
        excludedAt: new Date().toISOString(),
      },
    },
  };
}

function writeJsonAtomically(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function lockRun(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'wx');
    fs.writeFileSync(descriptor, `${process.pid}\n`);
  } catch (error) {
    if (error?.code === 'EEXIST')
      throw new Error(`benchmark is already locked: ${file}`);
    throw error;
  }
  return () => {
    fs.closeSync(descriptor);
    fs.unlinkSync(file);
  };
}

function loadState(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveState(file, state) {
  writeJsonAtomically(file, state);
}

function apiClient(baseUrl, credentials) {
  let cookies = '';
  return async function request(method, pathname, body) {
    const response = await fetch(new URL(pathname, `${baseUrl}/`), {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(cookies ? { cookie: cookies } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      cookies = setCookie
        .split(/,(?=\s*[^;=]+=)/)
        .map((value) => value.split(';')[0])
        .join('; ');
    }
    const raw = await response.text();
    let payload;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = raw;
    }
    if (response.status === 401 && pathname !== '/auth/login') {
      await request('POST', '/auth/login', credentials);
      return request(method, pathname, body);
    }
    if (!response.ok) {
      throw new Error(`${method} ${pathname} failed (${response.status})`);
    }
    return payload;
  };
}

function messageRows(payload) {
  return Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.messages)
      ? payload.messages
      : [];
}

function outputFromMessage(message, item, conversationId) {
  return {
    status: 'COMPLETED',
    answer: typeof message?.content === 'string' ? message.content : '',
    citations: Array.isArray(message?.metadata?.citations)
      ? message.metadata.citations
      : Array.isArray(message?.citations)
        ? message.citations
        : [],
    reelId: item.input?.reelIds?.[0] ?? null,
    evidenceIds: item.input?.evidenceIds ?? [],
    modality: item.input?.modality ?? null,
    conversationId,
    assistantMessageId: message?.id ?? null,
  };
}

function findBotMessage(payload, userCreatedAt) {
  const threshold = new Date(userCreatedAt ?? 0).getTime();
  return messageRows(payload).find(
    (message) =>
      message?.senderId === BOT_USER_ID &&
      new Date(message.createdAt ?? 0).getTime() >= threshold,
  );
}

async function waitForBotMessage(
  request,
  conversationId,
  userCreatedAt,
  maxAttempts = 60,
) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const messages = await request(
      'GET',
      `/conversations/${conversationId}/messages?limit=50`,
    );
    const assistant = findBotMessage(messages, userCreatedAt);
    if (assistant) return assistant;
  }
  throw new Error(`bot response timeout for ${conversationId}`);
}

async function ensureReady(request, reelIds) {
  const failures = [];
  for (let index = 0; index < reelIds.length; index += 8) {
    const batch = reelIds.slice(index, index + 8);
    const statuses = await Promise.all(
      batch.map(async (reelId) => ({
        reelId,
        status: await request('GET', `/content/reels/${reelId}/status`),
      })),
    );
    for (const { reelId, status } of statuses) {
      if (
        status?.status !== 'COMPLETED' ||
        status?.mediaStatus !== 'COMPLETED' ||
        status?.indexStatus !== 'COMPLETED'
      ) {
        failures.push({
          reelId,
          status: status?.status,
          mediaStatus: status?.mediaStatus,
          indexStatus: status?.indexStatus,
        });
      }
    }
  }
  if (failures.length)
    throw new Error(`reel readiness failed for ${failures.length} reels`);
}

async function runCase({
  item,
  state,
  stateFile,
  request,
  runId,
  autoExcludeTimeouts = false,
}) {
  const caseId = item.id;
  const current = state.cases[caseId] ?? { status: 'PENDING' };
  if (current.status === 'COMPLETED') return current.output;
  if (current.status === 'IN_FLIGHT') {
    if (!current.conversationId || !current.userMessageId)
      throw new Error(`in-flight case ${caseId} is missing request identity`);
    const messages = await request(
      'GET',
      `/conversations/${current.conversationId}/messages?limit=50`,
    );
    const assistant = findBotMessage(messages, current.userMessageCreatedAt);
    if (!assistant) {
      if (autoExcludeTimeouts) {
        Object.assign(
          state,
          excludeInFlightCase(state, caseId, 'RAG_RESPONSE_TIMEOUT_UNRESOLVED'),
        );
        saveState(stateFile, state);
        return {
          status: 'EXCLUDED',
          exclusionReason: 'RAG_RESPONSE_TIMEOUT_UNRESOLVED',
        };
      }
      throw new Error(
        `in-flight case ${caseId} has no reconciled bot response; refusing resend`,
      );
    }
    const output = outputFromMessage(assistant, item, current.conversationId);
    state.cases[caseId] = {
      ...current,
      status: 'COMPLETED',
      completedAt: new Date().toISOString(),
      output,
    };
    saveState(stateFile, state);
    return output;
  }
  if (current.status !== 'PENDING')
    throw new Error(`unsupported state ${current.status} for ${caseId}`);

  const reelId = item.input?.reelIds?.[0];
  const question = item.input?.question;
  if (
    typeof reelId !== 'string' ||
    typeof question !== 'string' ||
    !question.trim()
  ) {
    throw new Error(`invalid dataset item ${caseId}`);
  }
  const created = await request('POST', '/conversations', {
    participantIds: [BOT_USER_ID],
    type: 'GROUP',
    isGroup: true,
    name: `Langfuse benchmark ${caseId}`,
  });
  const conversationId = created?.id;
  if (!conversationId)
    throw new Error(`conversation create returned no id for ${caseId}`);
  await request('POST', `/content/reels/${reelId}/share`, {
    conversationId,
    sharedWithUserId: BOT_USER_ID,
  });
  const clientMessageId = `langfuse-${runId}-${caseId}-${crypto.randomUUID()}`;
  state.cases[caseId] = {
    status: 'IN_FLIGHT',
    attemptCount: (current.attemptCount ?? 0) + 1,
    retryCount: current.retryCount ?? 0,
    conversationId,
    clientMessageId,
    userMessageId: null,
    requestStartedAt: new Date().toISOString(),
  };
  saveState(stateFile, state);
  const userMessage = await request(
    'POST',
    `/conversations/${conversationId}/messages`,
    {
      clientMessageId,
      content: question,
      type: 'text',
      signalType: 0,
    },
  );
  state.cases[caseId] = {
    status: 'IN_FLIGHT',
    attemptCount: state.cases[caseId].attemptCount,
    retryCount: state.cases[caseId].retryCount,
    conversationId,
    clientMessageId,
    userMessageId: userMessage?.id ?? null,
    userMessageCreatedAt: userMessage?.createdAt ?? new Date().toISOString(),
    requestStartedAt: new Date().toISOString(),
  };
  saveState(stateFile, state);
  const assistant = await waitForBotMessage(
    request,
    conversationId,
    userMessage?.createdAt,
    autoExcludeTimeouts ? 15 : 60,
  );
  const output = outputFromMessage(assistant, item, conversationId);
  state.cases[caseId] = {
    ...state.cases[caseId],
    status: 'COMPLETED',
    completedAt: new Date().toISOString(),
    output,
  };
  saveState(stateFile, state);
  return output;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  dotenv.config({
    path: args['langfuse-env'] || path.resolve(process.cwd(), '.env'),
  });
  dotenv.config({
    path: args['backend-env'] || path.resolve(process.cwd(), '.env.test.local'),
  });
  const runId = String(args['run-id'] || args.resume || nowRunId());
  const stateDir = path.resolve(
    args['state-dir'] || '/tmp/velora-langfuse-live-benchmark',
  );
  const stateFile = path.join(stateDir, `${runId}.state.json`);
  const lockFile = path.join(stateDir, `${runId}.lock`);
  fs.mkdirSync(stateDir, { recursive: true });
  const releaseLock = lockRun(lockFile);
  const { LangfuseClient } = require('@langfuse/client');
  const client = new LangfuseClient({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL,
  });
  try {
    if (args['rescore-summary']) {
      const targetStateFile = path.resolve(String(args['rescore-summary']));
      const targetState = loadState(targetStateFile);
      const targetRunId = String(
        args['run-id'] ||
          targetState.runId ||
          path.basename(targetStateFile, '.state.json'),
      );
      const dataset = await client.dataset.get(
        targetState.datasetName || DATASET_NAME,
      );
      const items = [...dataset.items].sort((left, right) =>
        left.id.localeCompare(right.id),
      );
      const completedItems = items.filter(
        (item) => targetState.cases[item.id]?.status === 'COMPLETED',
      );
      const summary = {
        schemaVersion: 'langfuse-live-benchmark-summary-v1',
        runId: targetRunId,
        datasetName: targetState.datasetName || DATASET_NAME,
        datasetFingerprint: targetState.datasetFingerprint,
        datasetRunId: targetState.datasetRunId ?? null,
        totalCases: items.length,
        completedCases: completedItems.length,
        excludedCases: items.filter(
          (item) => targetState.cases[item.id]?.status === 'EXCLUDED',
        ).length,
        pendingCases:
          items.length -
          completedItems.length -
          items.filter(
            (item) => targetState.cases[item.id]?.status === 'EXCLUDED',
          ).length,
        productionRagRequestAttempts: Object.values(targetState.cases).reduce(
          (total, item) => total + (item.attemptCount ?? 0),
          0,
        ),
        deterministicMetrics: aggregateEvaluations(
          completedItems.map((item) => ({
            input: item.input,
            expectedOutput: item.expectedOutput,
            output: targetState.cases[item.id]?.output,
          })),
        ),
        stateFile: targetStateFile,
        completedAt: new Date().toISOString(),
      };
      const summaryFile = targetStateFile.endsWith('.state.json')
        ? targetStateFile.replace(/\.state\.json$/, '.summary.json')
        : `${targetStateFile}.summary.json`;
      writeJsonAtomically(summaryFile, summary);
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    if (
      !process.env.BACKEND_URL ||
      !process.env.VELORA_TEST_EMAIL ||
      !process.env.VELORA_TEST_PASSWORD
    ) {
      throw new Error('BACKEND_URL and benchmark credentials are required');
    }
    const dataset = await client.dataset.get(DATASET_NAME);
    const items = [...dataset.items].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    if (items.length !== TARGET_CASES)
      throw new Error(
        `expected ${TARGET_CASES} dataset items, received ${items.length}`,
      );
    const itemIds = items.map((item) => item.id);
    const datasetFingerprint = sha256(
      JSON.stringify(
        items.map((item) => ({
          id: item.id,
          input: item.input,
          expectedOutput: item.expectedOutput,
        })),
      ),
    );
    let state;
    if (args.resume || fs.existsSync(stateFile)) {
      state = loadState(stateFile);
      if (
        state.datasetName !== DATASET_NAME ||
        state.datasetFingerprint !== datasetFingerprint
      )
        throw new Error('dataset fingerprint mismatch; refusing resume');
      if (JSON.stringify(state.itemIds) !== JSON.stringify(itemIds))
        throw new Error('dataset item identity mismatch; refusing resume');
    } else {
      state = {
        schemaVersion: 'langfuse-live-benchmark-state-v1',
        runId,
        datasetName: DATASET_NAME,
        datasetFingerprint,
        itemIds,
        createdAt: new Date().toISOString(),
        cases: Object.fromEntries(
          items.map((item) => [item.id, { status: 'PENDING' }]),
        ),
      };
      saveState(stateFile, state);
    }
    for (const item of Object.values(state.cases)) {
      if (item.status !== 'PENDING' && item.attemptCount === undefined)
        item.attemptCount = 1;
    }
    saveState(stateFile, state);
    const request = apiClient(process.env.BACKEND_URL.replace(/\/$/, ''), {
      email: process.env.VELORA_TEST_EMAIL,
      password: process.env.VELORA_TEST_PASSWORD,
    });
    await request('POST', '/auth/login', {
      email: process.env.VELORA_TEST_EMAIL,
      password: process.env.VELORA_TEST_PASSWORD,
    });
    const excludeCaseId = args['exclude-in-flight-case'];
    if (excludeCaseId) {
      const exclusionReason = String(args['exclude-reason'] || '');
      state = excludeInFlightCase(state, excludeCaseId, exclusionReason);
      saveState(stateFile, state);
      console.log(
        JSON.stringify({ excludeCaseId, exclusionReason, excluded: true }),
      );
    }
    const retryCaseId = args['retry-in-flight-case'];
    if (retryCaseId) {
      const failureCategory = String(args['retry-failure-category'] || '');
      const current = state.cases[retryCaseId];
      if (!current?.conversationId) {
        throw new Error(
          `case ${retryCaseId} has no conversation for retry reconciliation`,
        );
      }
      const messages = await request(
        'GET',
        `/conversations/${current.conversationId}/messages?limit=50`,
      );
      if (findBotMessage(messages, current.userMessageCreatedAt)) {
        throw new Error(
          `case ${retryCaseId} already has a bot response; do not retry it`,
        );
      }
      state = prepareInFlightRetry(state, retryCaseId, failureCategory);
      saveState(stateFile, state);
      console.log(
        JSON.stringify({ retryCaseId, failureCategory, retryAuthorized: true }),
      );
    }
    const reelIds = [
      ...new Set(items.map((item) => item.input?.reelIds?.[0]).filter(Boolean)),
    ];
    await ensureReady(request, reelIds);
    const pending = items.filter(
      (item) =>
        !['COMPLETED', 'EXCLUDED'].includes(state.cases[item.id]?.status),
    );
    console.log(
      JSON.stringify({
        runId,
        datasetName: DATASET_NAME,
        totalCases: items.length,
        distinctReels: reelIds.length,
        pendingCases: pending.length,
        stateFile,
      }),
    );
    if (pending.length) {
      let halted = false;
      const autoExcludeTimeouts = Boolean(args['auto-exclude-timeouts']);
      const result = await dataset.runExperiment({
        name: 'Velora live RAG benchmark 220',
        runName: runId,
        description:
          'One fresh bot conversation per generated Reel question; sequential, checkpointed application benchmark.',
        metadata: {
          datasetVersion: 'rag-scraped-v1-provisional',
          benchmarkRunId: runId,
          productionRagCallsAuthorized: TARGET_CASES,
        },
        data: pending,
        maxConcurrency: Math.min(
          Math.max(Number.parseInt(args.concurrency ?? '1', 10) || 1, 1),
          4,
        ),
        task: async (item) => {
          if (halted)
            throw new Error(
              'benchmark halted after an unresolved case; no further RAG request allowed',
            );
          try {
            const output = await runCase({
              item,
              state,
              stateFile,
              request,
              runId,
              autoExcludeTimeouts,
            });
            const completed = Object.values(state.cases).filter(
              (entry) => entry.status === 'COMPLETED',
            ).length;
            if (output?.status === 'EXCLUDED') {
              console.log(
                `BENCHMARK_CASE_EXCLUDED=${item.id} REASON=RAG_RESPONSE_TIMEOUT_UNRESOLVED`,
              );
            } else {
              console.log(
                `BENCHMARK_CASE_COMPLETED=${item.id} COMPLETED=${completed}/${items.length}`,
              );
            }
            return output;
          } catch (error) {
            if (
              autoExcludeTimeouts &&
              error instanceof Error &&
              error.message.startsWith('bot response timeout')
            ) {
              state = excludeInFlightCase(
                state,
                item.id,
                'RAG_RESPONSE_TIMEOUT_UNRESOLVED',
              );
              saveState(stateFile, state);
              console.log(
                `BENCHMARK_CASE_EXCLUDED=${item.id} REASON=RAG_RESPONSE_TIMEOUT_UNRESOLVED`,
              );
              return {
                status: 'EXCLUDED',
                exclusionReason: 'RAG_RESPONSE_TIMEOUT_UNRESOLVED',
              };
            }
            halted = true;
            throw error;
          }
        },
        evaluators: [
          async ({ input, expectedOutput, output }) =>
            output?.status === 'EXCLUDED'
              ? []
              : deterministicEvaluations(input, expectedOutput, output),
        ],
      });
      state.datasetRunId = result.datasetRunId ?? state.datasetRunId ?? null;
      saveState(stateFile, state);
    }
    const completedItems = items.filter(
      (item) => state.cases[item.id]?.status === 'COMPLETED',
    );
    const summary = {
      schemaVersion: 'langfuse-live-benchmark-summary-v1',
      runId,
      datasetName: DATASET_NAME,
      datasetFingerprint,
      datasetRunId: state.datasetRunId ?? null,
      totalCases: items.length,
      completedCases: completedItems.length,
      excludedCases: items.filter(
        (item) => state.cases[item.id]?.status === 'EXCLUDED',
      ).length,
      pendingCases:
        items.length -
        completedItems.length -
        items.filter((item) => state.cases[item.id]?.status === 'EXCLUDED')
          .length,
      productionRagRequestAttempts: Object.values(state.cases).reduce(
        (total, item) => total + (item.attemptCount ?? 0),
        0,
      ),
      deterministicMetrics: aggregateEvaluations(
        completedItems.map((item) => ({
          input: item.input,
          expectedOutput: item.expectedOutput,
          output: state.cases[item.id].output,
        })),
      ),
      stateFile,
      completedAt: new Date().toISOString(),
    };
    const summaryFile = path.join(stateDir, `${runId}.summary.json`);
    writeJsonAtomically(summaryFile, summary);
    console.log(JSON.stringify(summary, null, 2));
    if (summary.completedCases + summary.excludedCases !== TARGET_CASES) {
      process.exitCode = 2;
    } else if (summary.excludedCases > 0) {
      process.exitCode = 3;
    }
  } finally {
    await client.shutdown();
    releaseLock();
  }
}

if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

module.exports = {
  aggregateEvaluations,
  citationEvidenceIds,
  deterministicEvaluations,
  normalize,
  excludeInFlightCase,
  prepareInFlightRetry,
  tokenRecall,
};
