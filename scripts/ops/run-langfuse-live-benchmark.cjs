#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // Ignore on older Node runtimes
}

const origLookup = dns.lookup;
dns.lookup = function (hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  return origLookup(hostname, { ...options, family: 4 }, callback);
};

const {
  EVALUATOR_VERSION,
  attachTrace,
  verifyDataset,
  fingerprint,
  strictEvaluations,
} = require('./rag-evaluation-contract.cjs');
const { loadSessionTraces } = require('./langfuse-rag-traces.cjs');

const DATASET_NAME = 'velora/rag-scraped-v1-provisional';
const TARGET_CASES = 220;
const BENCHMARK_EVALUATOR_VERSION = 'velora-rag-benchmark-evaluation-v9';
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

function isFullReleaseSha(value) {
  return /^[0-9a-f]{40}$/i.test(String(value ?? '').trim());
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assertExpectedDatasetSha256(actual, expected) {
  if (expected === undefined || expected === null || expected === '') return;
  const pinned = String(expected).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pinned) || actual !== pinned)
    throw new Error(
      'Frozen dataset SHA-256 does not match the workflow pin; no RAG request was sent',
    );
}

function normalize(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function acceptedAnswerVariants(expectedOutput) {
  const values = [
    expectedOutput?.answer,
    ...(Array.isArray(expectedOutput?.acceptedAnswers)
      ? expectedOutput.acceptedAnswers
      : []),
  ].filter((value) => typeof value === 'string' && value.trim());
  return values.length
    ? [...new Set(values.map((value) => value.trim()))]
    : [String(expectedOutput?.answer ?? '')];
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

function tokenF1(expected, actual) {
  const expectedTokens = tokens(expected);
  const actualTokens = tokens(actual);
  if (!expectedTokens.length && !actualTokens.length) return 1;
  if (!expectedTokens.length || !actualTokens.length) return 0;

  const expectedCounts = new Map();
  for (const token of expectedTokens) {
    expectedCounts.set(token, (expectedCounts.get(token) || 0) + 1);
  }
  let commonCount = 0;
  const actualCounts = new Map();
  for (const token of actualTokens) {
    actualCounts.set(token, (actualCounts.get(token) || 0) + 1);
  }
  for (const [token, count] of actualCounts.entries()) {
    if (expectedCounts.has(token)) {
      commonCount += Math.min(count, expectedCounts.get(token));
    }
  }
  if (commonCount === 0) return 0;
  const precision = commonCount / actualTokens.length;
  const recall = commonCount / expectedTokens.length;
  return (2 * precision * recall) / (precision + recall);
}

function normalizePunctuation(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/["'“”‘’`]/g, '')
    .replace(/[-_.,:;!?(){}[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SHORT_STOPWORDS = new Set([
  'a',
  'an',
  'as',
  'at',
  'by',
  'do',
  'he',
  'if',
  'in',
  'is',
  'it',
  'me',
  'my',
  'no',
  'of',
  'on',
  'or',
  'so',
  'to',
  'up',
  'we',
]);

function containmentMatch(expected, actual) {
  const normExpected = normalizePunctuation(expected);
  const normActual = normalizePunctuation(actual);
  if (!normExpected || !normActual) return 0;
  if (normActual === normExpected) return 1;
  if (normActual.includes(normExpected)) return 1;

  if (normExpected.includes(normActual)) {
    const actTokens = tokens(normActual);
    if (actTokens.length >= 2) return 1;
    if (
      actTokens.length === 1 &&
      (/^\d+$/.test(actTokens[0]) ||
        (actTokens[0].length >= 3 && !SHORT_STOPWORDS.has(actTokens[0])))
    ) {
      return 1;
    }
  }
  return 0;
}

function isClearAbstention(answer) {
  return /\b(?:cannot|can't|could not|couldn't|unable to|not enough|insufficient|no relevant|cannot verify|can't verify|not established|not available|does not contain enough|doesn't contain enough)\b/i.test(
    String(answer ?? ''),
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
  const expectedAnswers = acceptedAnswerVariants(expectedOutput);
  const actualAnswer = output?.answer ?? '';
  const expectedEvidenceIds =
    expectedOutput?.evidenceIds ?? input?.evidenceIds ?? [];
  const expectedEvidence = new Set(expectedEvidenceIds);
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
  const expectedReelIds = expectedOutput?.reelIds ?? input?.reelIds ?? [];
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
  const isAbstention = expectedOutput?.answerType === 'ABSTENTION';
  return [
    ...(isAbstention
      ? [
          {
            name: 'abstention_correct',
            value: Number(
              isClearAbstention(actualAnswer) && citations.length === 0,
            ),
            dataType: 'NUMERIC',
          },
        ]
      : [
          {
            name: 'answer_exact_match',
            value: Number(
              expectedAnswers.some(
                (answer) => normalize(answer) === normalize(actualAnswer),
              ),
            ),
            dataType: 'NUMERIC',
          },
          {
            name: 'answer_containment_match',
            value: Math.max(
              0,
              ...expectedAnswers.map((answer) =>
                containmentMatch(answer, actualAnswer),
              ),
            ),
            dataType: 'NUMERIC',
          },
          {
            name: 'answer_token_f1',
            value: Math.max(
              0,
              ...expectedAnswers.map((answer) => tokenF1(answer, actualAnswer)),
            ),
            dataType: 'NUMERIC',
          },
          {
            name: 'answer_token_recall',
            value: Math.max(
              0,
              ...expectedAnswers.map((answer) =>
                tokenRecall(answer, actualAnswer),
              ),
            ),
            dataType: 'NUMERIC',
          },
        ]),
    {
      name: 'evidence_recall',
      value: expectedEvidence.size
        ? matchedEvidence.length / expectedEvidence.size
        : 1,
      dataType: 'NUMERIC',
    },
    {
      name: 'reel_citation_match',
      value:
        expectedOutput?.answerType === 'ABSTENTION' &&
        expectedEvidence.size === 0
          ? citations.length === 0
            ? 1
            : 0
          : expectedReelIds.length > 0 &&
              expectedReelIds.every((reelId) => citedReels.has(reelId))
            ? 1
            : 0,
      dataType: 'NUMERIC',
    },
    {
      name: 'modality_match',
      value:
        Array.isArray(expectedOutput?.expectedEvidenceTypes) &&
        expectedOutput.expectedEvidenceTypes.length > 0
          ? [...new Set(expectedOutput.expectedEvidenceTypes)].every((type) =>
              modalities.has(type),
            )
            ? 1
            : 0
          : expectedModality
            ? modalities.has(expectedModality)
              ? 1
              : 0
            : citations.length === 0
              ? 1
              : 0,
      dataType: 'NUMERIC',
    },
  ].filter((score) => !(isAbstention && score.name === 'evidence_recall'));
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

function benchmarkEvaluations(input, expectedOutput, output) {
  const scores = [
    ...deterministicEvaluations(input, expectedOutput, output).map((score) =>
      score.name === 'evidence_recall'
        ? { ...score, name: 'reel_evidence_proxy_recall' }
        : score,
    ),
    ...strictEvaluations(input, expectedOutput, output),
  ];
  if (Number.isFinite(output?.workflowLatencyMs))
    scores.push({
      name: 'workflow_latency_ms',
      value: output.workflowLatencyMs,
      dataType: 'NUMERIC',
    });
  scores.push({
    name: 'execution_health_available',
    value: Number(output?.executionHealth?.status === 'AVAILABLE'),
    dataType: 'NUMERIC',
  });
  return scores;
}

function aggregateLatency(cases) {
  const values = cases
    .map((item) => item.output?.workflowLatencyMs)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  const quantile = (ratio) =>
    values.length ? values[Math.ceil(values.length * ratio) - 1] : null;
  return {
    count: values.length,
    meanMs: values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null,
    p50Ms: quantile(0.5),
    p95Ms: quantile(0.95),
  };
}

function executionHealthCounts(cases) {
  return cases.reduce(
    (counts, item) => {
      const status = item.output?.executionHealth?.status || 'UNKNOWN';
      counts[status] = (counts[status] || 0) + 1;
      return counts;
    },
    { AVAILABLE: 0, DEGRADED: 0, UNKNOWN: 0 },
  );
}
function aggregateBenchmarkEvaluations(cases) {
  const values = new Map();
  for (const item of cases)
    for (const score of benchmarkEvaluations(
      item.input,
      item.expectedOutput,
      item.output,
    )) {
      const list = values.get(score.name) ?? [];
      list.push(score.value);
      values.set(score.name, list);
    }
  return Object.fromEntries(
    [...values].map(([key, values]) => [
      key,
      {
        mean: values.reduce((a, b) => a + b, 0) / values.length,
        count: values.length,
      },
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
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
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
  return async function request(method, pathname, body, maxRetries = 5) {
    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      try {
        const response = await fetch(new URL(pathname, `${baseUrl}/`), {
          method,
          headers: {
            ...(body ? { 'content-type': 'application/json' } : {}),
            ...(cookies ? { cookie: cookies } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(45_000),
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
          const isRetryableStatus = [408, 429, 500, 502, 503, 504].includes(
            response.status,
          );
          if (isRetryableStatus && attempt + 1 < maxRetries) {
            const delayMs = Math.min(10_000, 1_000 * 2 ** attempt);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          }
          throw new Error(`${method} ${pathname} failed (${response.status})`);
        }
        return payload;
      } catch (error) {
        if (attempt + 1 < maxRetries) {
          const delayMs = Math.min(10_000, 1_000 * 2 ** attempt);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        throw error;
      }
    }
  };
}

function messageRows(payload) {
  return Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.messages)
      ? payload.messages
      : [];
}

function outputFromMessage(message, conversationId) {
  return {
    status: 'COMPLETED',
    answer: typeof message?.content === 'string' ? message.content : '',
    citations: Array.isArray(message?.metadata?.citations)
      ? message.metadata.citations
      : Array.isArray(message?.citations)
        ? message.citations
        : [],
    evidenceIds: citationEvidenceIds(
      message?.metadata?.citations ?? message?.citations,
    ),
    modalities: [
      ...new Set(
        (message?.metadata?.citations ?? message?.citations ?? []).map(
          (citation) => citation.evidenceType,
        ),
      ),
    ],
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
    try {
      const messages = await request(
        'GET',
        `/conversations/${conversationId}/messages?limit=50`,
      );
      const assistant = findBotMessage(messages, userCreatedAt);
      if (assistant) return assistant;
    } catch (error) {
      if (attempt + 1 >= maxAttempts) throw error;
      // Continue polling if a transient 502/network error occurred during a poll attempt
    }
  }
  throw new Error(`bot response timeout for ${conversationId}`);
}

async function waitForRagTrace(client, conversationId, maxAttempts = 15) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const traces = await loadSessionTraces(client, [conversationId]);
    if (traces.length > 1)
      throw new Error(`ambiguous RAG workflow traces for ${conversationId}`);
    if (traces.length === 1) return traces[0];
    if (attempt + 1 < maxAttempts)
      await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`RAG workflow trace timeout for ${conversationId}`);
}

async function attachRagTrace(client, output, conversationId) {
  return attachTrace(
    output,
    await waitForRagTrace(client, conversationId),
    conversationId,
  );
}

function reelIdsForItem(item) {
  const ids = [...new Set(item.input?.reelIds ?? [])];
  if (
    ids.length === 0 ||
    ids.some((reelId) => typeof reelId !== 'string' || !reelId.trim())
  )
    throw new Error(`invalid dataset Reel IDs for ${item.id}`);
  return ids;
}

async function shareReels(request, conversationId, reelIds) {
  for (const reelId of reelIds)
    await request('POST', `/content/reels/${reelId}/share`, {
      conversationId,
      sharedWithUserId: BOT_USER_ID,
    });
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
  langfuseClient,
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
    const output = await attachRagTrace(
      langfuseClient,
      outputFromMessage(assistant, current.conversationId),
      current.conversationId,
    );
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

  const reelIds = reelIdsForItem(item);
  const question = item.input?.question;
  if (typeof question !== 'string' || !question.trim()) {
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
  await shareReels(request, conversationId, reelIds);
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
    autoExcludeTimeouts ? 90 : 100,
  );
  const output = await attachRagTrace(
    langfuseClient,
    outputFromMessage(assistant, conversationId),
    conversationId,
  );
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
  const datasetName = String(args.dataset || DATASET_NAME);
  const serviceReleaseSha = String(
    args['release-sha'] || process.env.RAG_RELEASE_SHA || '',
  ).trim();
  const expectedCases = Number(
    args['expected-cases'] ??
      (datasetName === DATASET_NAME ? TARGET_CASES : NaN),
  );
  if (!Number.isInteger(expectedCases) || expectedCases < 1)
    throw new Error(
      'A non-provisional dataset requires an explicit positive --expected-cases',
    );
  if (datasetName !== DATASET_NAME && !isFullReleaseSha(serviceReleaseSha))
    throw new Error(
      'A full --release-sha is required for a non-provisional dataset',
    );
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
        targetState.datasetName || datasetName,
        { fetchItemsPageSize: 100 },
      );
      const items = [...dataset.items].sort((left, right) =>
        left.id.localeCompare(right.id),
      );
      verifyDataset(
        targetState,
        items.map(({ id, input, expectedOutput, metadata }) => ({
          id,
          input,
          expectedOutput,
          metadata,
        })),
      );
      const completedItems = items.filter(
        (item) => targetState.cases[item.id]?.status === 'COMPLETED',
      );
      const summary = {
        schemaVersion: 'langfuse-live-benchmark-summary-v1',
        runId: targetRunId,
        datasetName: targetState.datasetName || datasetName,
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
        deterministicMetrics: aggregateBenchmarkEvaluations(
          completedItems.map((item) => ({
            input: item.input,
            expectedOutput: item.expectedOutput,
            output: targetState.cases[item.id]?.output,
          })),
        ),
        workflowLatency: aggregateLatency(
          completedItems.map((item) => ({
            output: targetState.cases[item.id]?.output,
          })),
        ),
        executionHealth: executionHealthCounts(
          completedItems.map((item) => ({
            output: targetState.cases[item.id]?.output,
          })),
        ),
        stateFile: targetStateFile,
        completedAt: new Date().toISOString(),
      };
      if (!args.output || fs.existsSync(path.resolve(String(args.output))))
        throw new Error(
          'Rescoring requires a new --output path; original summaries are immutable',
        );
      writeJsonAtomically(path.resolve(String(args.output)), summary);
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
    const dataset = await client.dataset.get(datasetName, {
      fetchItemsPageSize: 100,
    });
    const items = [...dataset.items].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    if (items.length !== expectedCases)
      throw new Error(
        `expected ${expectedCases} dataset items, received ${items.length}`,
      );
    const datasetSnapshot = items.map(
      ({ id, input, expectedOutput, metadata }) => ({
        id,
        input,
        expectedOutput,
        metadata,
      }),
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
    assertExpectedDatasetSha256(
      fingerprint(datasetSnapshot),
      args['expected-dataset-sha256'],
    );
    let state;
    if (args.resume || fs.existsSync(stateFile)) {
      state = loadState(stateFile);
      if (
        Object.values(state.cases).every((item) =>
          ['COMPLETED', 'EXCLUDED'].includes(item.status),
        )
      )
        throw new Error(
          'Completed runs are immutable; use analyze-rag-benchmark with a new output path',
        );
      if (
        state.datasetName !== datasetName ||
        state.datasetFingerprint !== datasetFingerprint ||
        (state.serviceReleaseSha &&
          state.serviceReleaseSha !== serviceReleaseSha)
      )
        throw new Error(
          'dataset or release fingerprint mismatch; refusing resume',
        );
      if (JSON.stringify(state.itemIds) !== JSON.stringify(itemIds))
        throw new Error('dataset item identity mismatch; refusing resume');
    } else {
      state = {
        schemaVersion: 'langfuse-live-benchmark-state-v1',
        runId,
        datasetName: datasetName,
        datasetFingerprint,
        serviceReleaseSha: serviceReleaseSha || null,
        itemIds,
        createdAt: new Date().toISOString(),
        cases: Object.fromEntries(
          items.map((item) => [item.id, { status: 'PENDING' }]),
        ),
      };
      saveState(stateFile, state);
    }
    if (!state.datasetSnapshot) {
      state.datasetSnapshot = datasetSnapshot;
      state.evaluatorVersion = BENCHMARK_EVALUATOR_VERSION;
      state.snapshotFingerprint = fingerprint(datasetSnapshot);
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
        datasetName: datasetName,
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
        name: 'Velora live RAG benchmark',
        runName: runId,
        description: `One fresh bot conversation per dataset question; sequential, checkpointed live backend run for ${dataset.metadata?.datasetVersion || datasetName}.`,
        metadata: {
          datasetVersion: dataset.metadata?.datasetVersion || datasetName,
          datasetSha256:
            dataset.metadata?.datasetSha256 ||
            dataset.metadata?.datasetContentSha256 ||
            null,
          serviceReleaseSha,
          executionMode: 'LIVE_PRODUCTION_BACKEND',
          benchmarkRunId: runId,
          productionRagCallsAuthorized: expectedCases,
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
              langfuseClient: client,
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
              : benchmarkEvaluations(input, expectedOutput, output),
        ],
      });
      state.datasetRunId = result.datasetRunId ?? state.datasetRunId ?? null;
      saveState(stateFile, state);
    }
    const completedItems = items.filter(
      (item) => state.cases[item.id]?.status === 'COMPLETED',
    );
    const summary = {
      schemaVersion: 'langfuse-live-benchmark-summary-v2',
      evaluatorVersion: BENCHMARK_EVALUATOR_VERSION,
      runId,
      datasetName: datasetName,
      serviceReleaseSha: serviceReleaseSha || null,
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
      deterministicMetrics: aggregateBenchmarkEvaluations(
        completedItems.map((item) => ({
          input: item.input,
          expectedOutput: item.expectedOutput,
          output: state.cases[item.id].output,
        })),
      ),
      workflowLatency: aggregateLatency(
        completedItems.map((item) => ({
          output: state.cases[item.id]?.output,
        })),
      ),
      executionHealth: executionHealthCounts(
        completedItems.map((item) => ({
          output: state.cases[item.id]?.output,
        })),
      ),
      stateFile,
      completedAt: new Date().toISOString(),
    };
    const summaryFile = path.join(stateDir, `${runId}.summary.json`);
    writeJsonAtomically(summaryFile, summary);
    console.log(JSON.stringify(summary, null, 2));
    if (summary.completedCases + summary.excludedCases !== expectedCases) {
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
    console.error(error?.stack || error?.message || error);
    if (error?.cause) console.error('Cause:', error.cause);
    process.exitCode = 1;
  });

module.exports = {
  benchmarkEvaluations,
  outputFromMessage,
  aggregateEvaluations,
  aggregateLatency,
  executionHealthCounts,
  citationEvidenceIds,
  containmentMatch,
  deterministicEvaluations,
  normalize,
  isFullReleaseSha,
  isClearAbstention,
  excludeInFlightCase,
  prepareInFlightRetry,
  reelIdsForItem,
  shareReels,
  tokenF1,
  tokenRecall,
  BENCHMARK_EVALUATOR_VERSION,
  assertExpectedDatasetSha256,
};
