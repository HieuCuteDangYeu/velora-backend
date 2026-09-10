#!/usr/bin/env node

/*
 * Runs the fixed AMI RAG questions through public production APIs only.
 * Each case gets a fresh group conversation so a prior assistant answer
 * cannot become conversational context for a later case.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { normalizeCase } = require('./normalize-existing-ami-rag-retest.cjs');

const ROOT = path.resolve(__dirname, '../..');
const REPORT_DIR = path.join(ROOT, 'test-data/reel-integration/ami/reports');
const STATE_DIR = path.join(REPORT_DIR, 'state');
const BOT_USER_ID = 'b6ddf921-c87c-4f68-8d71-f1b1fd33f3e7';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message) {
  throw new Error(message);
}

function caseReelIds(definition) {
  if (typeof definition?.reelId === 'string') return [definition.reelId];
  if (Array.isArray(definition?.expectedReelIds)) {
    return definition.expectedReelIds;
  }
  return [];
}

function extractDistinctReelIds(definitions) {
  const cases = definitions?.ragBenchmark?.cases;
  if (!Array.isArray(cases) || cases.length !== 8) {
    fail('definitions report must contain exactly eight benchmark cases');
  }

  const perCase = cases.map((definition) => {
    const ids = caseReelIds(definition);
    if (!ids.length || ids.some((id) => typeof id !== 'string')) {
      fail(`case ${definition.caseId || '<unknown>'} must define reel IDs`);
    }
    if (ids.some((id) => !UUID_PATTERN.test(id))) {
      fail(
        `case ${definition.caseId || '<unknown>'} contains an invalid reel UUID`,
      );
    }
    return ids;
  });
  const distinct = [...new Set(perCase.flat())];
  if (distinct.length !== 4) {
    fail(
      `definitions report must contain exactly four distinct reel UUIDs; found ${distinct.length}`,
    );
  }
  return distinct;
}

function writeJsonAtomically(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function statePath(runId) {
  return path.join(STATE_DIR, `${runId}.json`);
}

function readState(runId) {
  const file = statePath(runId);
  if (!fs.existsSync(file)) fail(`benchmark run state not found: ${runId}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function formatStatus(runId, state) {
  const cases = state.cases || {};
  const counts = Object.values(cases).reduce(
    (result, item) => {
      const status = item?.status || 'PENDING';
      result[status] = (result[status] || 0) + 1;
      return result;
    },
    {
      PENDING: 0,
      IN_FLIGHT: 0,
      COMPLETED: 0,
      FAILED: 0,
      FAILED_RECONCILED: 0,
    },
  );
  return {
    benchmarkRunId: runId,
    statePath: statePath(runId),
    lockState: fs.existsSync(path.join(STATE_DIR, `${runId}.lock`))
      ? 'LOCKED'
      : 'UNLOCKED',
    counts,
    cases,
    warning:
      counts.IN_FLIGHT > 0
        ? 'DO NOT RESEND — RECONCILIATION REQUIRED'
        : undefined,
  };
}

function pendingCases(state, definitions) {
  return definitions.filter((definition) => {
    const status = state.cases[definition.caseId]?.status || 'PENDING';
    if (status === 'COMPLETED') return false;
    if (status !== 'PENDING')
      fail(
        `case ${definition.caseId} is ${status}; reconcile it through supported read-only APIs before retrying`,
      );
    return true;
  });
}

function markCaseInFlight(state, caseId, persist) {
  state.cases[caseId] = {
    status: 'IN_FLIGHT',
    requestStartedAt: new Date().toISOString(),
  };
  persist(state);
}

function completeCase(state, caseId, result, persist) {
  state.cases[caseId] = {
    status: 'COMPLETED',
    completedAt: new Date().toISOString(),
    ...result,
  };
  persist(state);
}

function normalizeMongoConnectionUrl(value) {
  if (!value) return value;
  const parsed = new URL(value);
  parsed.searchParams.delete('connection_limit');
  if (!parsed.searchParams.has('maxPoolSize')) {
    parsed.searchParams.set('maxPoolSize', '1');
  }
  return parsed.toString();
}

function buildReconciliationEvidence(input) {
  if (input.runLockAcquired !== true)
    fail('exclusive benchmark run lock was not acquired');
  if (input.progress?.status !== 'IN_FLIGHT')
    fail(`case is ${input.progress?.status || 'UNKNOWN'}, not IN_FLIGHT`);
  if (input.primaryMessages.length !== 1)
    fail(
      `expected exactly one primary request, found ${input.primaryMessages.length}`,
    );
  if (input.botMessages.length !== 0)
    fail(`bot response exists; no-resend reconciliation refused`);
  if (input.traces.length === 0)
    fail('no persisted trace proves that the workflow ended');
  if (input.traces.some((trace) => trace.hasAnswer))
    fail('a trace contains an answer; no-resend reconciliation refused');
  const latestTraceAt = Math.max(
    ...input.traces.map((trace) => new Date(trace.createdAt).getTime()),
  );
  if (!Number.isFinite(latestTraceAt)) fail('trace timestamp is invalid');
  if (input.nowMs - latestTraceAt < input.minimumQuietMs)
    fail('trace is still inside the configured quiet period');

  return {
    primaryRequestCount: 1,
    botResponseCount: 0,
    traceEvidenceCount: input.traces.length,
    latestTraceAt: new Date(latestTraceAt).toISOString(),
    activeRunLockBeforeReconciliation: false,
    workflowTerminalEvidence: 'RAG_TRACE_PERSISTED_AFTER_GRAPH_EXIT',
  };
}

function reconciledResult(definition, progress) {
  if (
    progress?.status !== 'FAILED_RECONCILED' ||
    !progress.conversationId ||
    !progress.userMessageId
  ) {
    fail(`reconciled case ${definition.caseId} is missing request identifiers`);
  }

  return {
    ...definition,
    status: 'FAILED_RECONCILED',
    conversationId: progress.conversationId,
    userMessageId: progress.userMessageId,
    reconciledAt: progress.reconciledAt,
    latencyMs: null,
    finalAnswer: '',
    citations: [],
    reconciliationReason: progress.reconciliationReason,
  };
}

function buildResponseReconciliationEvidence(input) {
  if (input.runLockAcquired !== true)
    fail('exclusive benchmark run lock was not acquired');
  if (input.progress?.status !== 'IN_FLIGHT')
    fail(`case is ${input.progress?.status || 'UNKNOWN'}, not IN_FLIGHT`);
  if (input.primaryMessages.length !== 1)
    fail(
      `expected exactly one primary request, found ${input.primaryMessages.length}`,
    );
  if (input.botMessages.length !== 1)
    fail(
      `expected exactly one bot response for response-present reconciliation, found ${input.botMessages.length}`,
    );

  const botMessage = input.botMessages[0];
  if (
    !botMessage?.id ||
    typeof botMessage.content !== 'string' ||
    !botMessage.content.trim()
  )
    fail('bot response is missing a non-empty message');
  if (input.traces.length === 0)
    fail('no persisted trace proves that the workflow ended');
  if (!input.traces.some((trace) => trace.hasAnswer))
    fail('no persisted trace contains the bot response answer');

  const latestTraceAt = Math.max(
    ...input.traces.map((trace) => new Date(trace.createdAt).getTime()),
  );
  const botResponseAt = new Date(botMessage.createdAt).getTime();
  if (!Number.isFinite(latestTraceAt) || !Number.isFinite(botResponseAt))
    fail('response or trace timestamp is invalid');
  const latestEventAt = Math.max(latestTraceAt, botResponseAt);
  if (input.nowMs - latestEventAt < input.minimumQuietMs)
    fail('response is still inside the configured quiet period');

  return {
    primaryRequestCount: 1,
    botResponseCount: 1,
    traceEvidenceCount: input.traces.length,
    latestTraceAt: new Date(latestTraceAt).toISOString(),
    latestBotResponseAt: new Date(botResponseAt).toISOString(),
    activeRunLockBeforeReconciliation: false,
    workflowTerminalEvidence: 'BOT_RESPONSE_AND_RAG_TRACE_PERSISTED',
    assistantMessageId: botMessage.id,
  };
}

function responseReconciledResult(
  definition,
  progress,
  assistantMessage,
  accessibleReelIds,
  runId,
) {
  if (
    progress?.status !== 'IN_FLIGHT' ||
    !progress.conversationId ||
    !progress.userMessageId
  ) {
    fail(`response-present case ${definition.caseId} is missing request identifiers`);
  }
  if (
    !assistantMessage?.id ||
    typeof assistantMessage.content !== 'string' ||
    !assistantMessage.content.trim()
  )
    fail(`response-present case ${definition.caseId} is missing a non-empty bot response`);

  const requestStartedAt = new Date(progress.requestStartedAt).getTime();
  const responseCompletedAt = new Date(assistantMessage.createdAt);
  const responseAt = responseCompletedAt.getTime();
  const latencyMs =
    Number.isFinite(requestStartedAt) && Number.isFinite(responseAt)
      ? Math.max(0, responseAt - requestStartedAt)
      : null;
  const result = {
    ...definition,
    status: 'EVALUATED',
    conversationId: progress.conversationId,
    accessibleReelIds,
    userMessageId: progress.userMessageId,
    assistantMessageId: assistantMessage.id,
    requestStartedAt: progress.requestStartedAt,
    responseCompletedAt: responseCompletedAt.toISOString(),
    latencyMs,
    finalAnswer: assistantMessage.content,
    citations: Array.isArray(assistantMessage.metadata?.citations)
      ? assistantMessage.metadata.citations
      : [],
  };
  result.normalized = normalizeCase(definition, result, null, runId);
  return result;
}

async function reconcileInFlight(runId) {
  const caseId = arg('--case-id');
  const conversationId = arg('--conversation-id');
  const userMessageId = arg('--user-message-id');
  if (!caseId || !conversationId || !userMessageId)
    fail('--case-id, --conversation-id, and --user-message-id are required');
  const minimumQuietMs = Number(arg('--minimum-quiet-ms') || 180_000);
  if (!Number.isFinite(minimumQuietMs) || minimumQuietMs < 120_000)
    fail('--minimum-quiet-ms must be at least 120000');

  const releaseLock = lockRun(runId);
  const state = readState(runId);
  try {
    dotenv.config({
      path: arg('--env-file') || path.join(ROOT, '.env.test.local'),
    });
    process.env.CONVERSATION_DATABASE_URL = normalizeMongoConnectionUrl(
      process.env.CONVERSATION_DATABASE_URL,
    );
    const {
      PrismaClient: ConversationClient,
    } = require('@prisma/conversation-client');
    const { PrismaClient: AiClient } = require('@prisma/ai-client');
    const conversation = new ConversationClient();
    const ai = new AiClient();
    try {
      const progress = state.cases?.[caseId];
      const [message, botMessages, traces] = await Promise.all([
        conversation.message.findFirst({
          where: { id: userMessageId, conversationId },
          select: { id: true, clientMessageId: true, createdAt: true },
        }),
        conversation.message.findMany({
          where: {
            conversationId,
            senderId: BOT_USER_ID,
            createdAt: { gte: new Date(progress?.requestStartedAt || 0) },
          },
          select: { id: true, createdAt: true, content: true, metadata: true },
        }),
        ai.ragTrace.findMany({
          where: { conversationId },
          select: { id: true, createdAt: true, answer: true },
        }),
      ]);
      const primaryMessages =
        message && message.clientMessageId.startsWith(`ami-rag-${caseId}-`)
          ? [message]
          : [];
      const traceEvidence = traces.map((trace) => ({
        createdAt: trace.createdAt,
        hasAnswer: Boolean(trace.answer),
      }));
      if (botMessages.length > 0) {
        const definitions = JSON.parse(
          fs.readFileSync(state.definitionsReport, 'utf8'),
        );
        const definition = definitions?.ragBenchmark?.cases?.find(
          (item) => item.caseId === caseId,
        );
        if (!definition) fail(`definition not found for ${caseId}`);
        const evidence = buildResponseReconciliationEvidence({
          runLockAcquired: true,
          progress,
          primaryMessages,
          botMessages,
          traces: traceEvidence,
          nowMs: Date.now(),
          minimumQuietMs,
        });
        const result = responseReconciledResult(
          definition,
          progress,
          botMessages[0],
          extractDistinctReelIds(definitions),
          runId,
        );
        state.cases[caseId] = {
          ...progress,
          status: 'COMPLETED',
          completedAt: new Date().toISOString(),
          assistantMessageId: botMessages[0].id,
          ...evidence,
          result,
        };
        writeJsonAtomically(statePath(runId), state);
        console.log(
          JSON.stringify(
            {
              benchmarkRunId: runId,
              caseId,
              status: state.cases[caseId].status,
              ...evidence,
            },
            null,
            2,
          ),
        );
        return;
      }
      const evidence = buildReconciliationEvidence({
        runLockAcquired: true,
        progress,
        primaryMessages,
        botMessages,
        traces: traceEvidence,
        nowMs: Date.now(),
        minimumQuietMs,
      });
      state.cases[caseId] = {
        ...progress,
        status: 'FAILED_RECONCILED',
        reconciledAt: new Date().toISOString(),
        reconciliationReason: 'WORKFLOW_ENDED_WITHOUT_BOT_RESPONSE',
        conversationId,
        userMessageId,
        ...evidence,
      };
      writeJsonAtomically(statePath(runId), state);
      console.log(
        JSON.stringify(
          { benchmarkRunId: runId, caseId, ...state.cases[caseId] },
          null,
          2,
        ),
      );
    } finally {
      await Promise.allSettled([conversation.$disconnect(), ai.$disconnect()]);
    }
  } finally {
    releaseLock();
  }
}

function lockRun(runId) {
  const file = path.join(STATE_DIR, `${runId}.lock`);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'wx');
    fs.writeFileSync(descriptor, `${process.pid}\n`);
  } catch (error) {
    if (error && error.code === 'EEXIST')
      fail(
        `benchmark run is already locked: ${runId}; use --status before resuming`,
      );
    throw error;
  }
  return () => {
    fs.closeSync(descriptor);
    fs.unlinkSync(file);
  };
}

async function retry(operation, description) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < 4)
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  throw new Error(
    `${description} failed after retries: ${lastError?.message || lastError}`,
  );
}

async function main() {
  const reconcileRunId = arg('--reconcile-in-flight');
  if (reconcileRunId) {
    await reconcileInFlight(reconcileRunId);
    return;
  }
  const statusRunId = arg('--status');
  if (statusRunId) {
    const state = readState(statusRunId);
    console.log(JSON.stringify(formatStatus(statusRunId, state), null, 2));
    return;
  }
  const definitionsPath = arg('--definitions-report');
  if (!definitionsPath) fail('--definitions-report is required');
  const resumeRunId = arg('--resume');
  const benchmarkRunId =
    resumeRunId ||
    arg('--run-id') ||
    `existing-ami-rag-${Date.now()}-${crypto.randomUUID()}`;
  const releaseLock = lockRun(benchmarkRunId);
  let state;
  try {
    dotenv.config({
      path: arg('--env-file') || path.join(ROOT, '.env.test.local'),
    });
    const baseUrl = process.env.BACKEND_URL;
    if (
      !baseUrl ||
      !process.env.VELORA_TEST_EMAIL ||
      !process.env.VELORA_TEST_PASSWORD
    ) {
      fail(
        'BACKEND_URL, VELORA_TEST_EMAIL, and VELORA_TEST_PASSWORD are required',
      );
    }
    const definitions = JSON.parse(fs.readFileSync(definitionsPath, 'utf8'));
    const allCases = definitions?.ragBenchmark?.cases;
    if (!Array.isArray(allCases) || allCases.length !== 8)
      fail('definitions report must contain exactly eight cases');
    const reelIds = extractDistinctReelIds(definitions);
    const onlyCaseId = arg('--case-id');
    const cases = onlyCaseId
      ? allCases.filter((item) => item.caseId === onlyCaseId)
      : allCases;
    if (cases.length === 0) fail(`unknown --case-id ${onlyCaseId}`);
    state = resumeRunId
      ? readState(benchmarkRunId)
      : {
          runId: benchmarkRunId,
          createdAt: new Date().toISOString(),
          definitionsReport: definitionsPath,
          cases: Object.fromEntries(
            cases.map((item) => [item.caseId, { status: 'PENDING' }]),
          ),
        };
    if (resumeRunId && state.definitionsReport !== definitionsPath)
      fail('resume definitions report does not match the original run');
    writeJsonAtomically(statePath(benchmarkRunId), state);
    console.log(
      JSON.stringify({ benchmarkRunId, statePath: statePath(benchmarkRunId) }),
    );

    let cookies = '';
    async function request(method, pathname, body) {
      const response = await fetch(new URL(pathname, baseUrl), {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(cookies ? { cookie: cookies } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie)
        cookies = setCookie
          .split(/,(?=\s*[^;=]+=)/)
          .map((value) => value.split(';')[0])
          .join('; ');
      const text = await response.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = text;
      }
      if (!response.ok)
        fail(
          `${method} ${pathname} -> ${response.status}: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`,
        );
      return payload;
    }

    await request('POST', '/auth/login', {
      email: process.env.VELORA_TEST_EMAIL,
      password: process.env.VELORA_TEST_PASSWORD,
    });
    const statuses = [];
    for (const reelId of reelIds)
      statuses.push({
        reelId,
        status: await request('GET', `/content/reels/${reelId}/status`),
      });
    const nonCompleted = statuses.filter(
      ({ status }) => status?.status !== 'COMPLETED',
    );
    if (nonCompleted.length)
      fail(`reel status precondition failed: ${JSON.stringify(nonCompleted)}`);

    const startedAt = new Date().toISOString();
    const resultCases = [];
    for (const [index, definition] of cases.entries()) {
      const progress = state.cases[definition.caseId] || { status: 'PENDING' };
      if (progress.status === 'COMPLETED') {
        resultCases.push(progress.result);
        continue;
      }
      if (progress.status === 'FAILED_RECONCILED') {
        resultCases.push(reconciledResult(definition, progress));
        continue;
      }
      if (progress.status !== 'PENDING') pendingCases(state, [definition]);
      markCaseInFlight(state, definition.caseId, (nextState) =>
        writeJsonAtomically(statePath(benchmarkRunId), nextState),
      );
      const name = `AMI controlled RAG ${definition.caseId} ${Date.now()}`;
      const created = await request('POST', '/conversations', {
        participantIds: [BOT_USER_ID],
        type: 'GROUP',
        isGroup: true,
        name,
      });
      const conversationId = created?.id;
      if (!conversationId)
        fail(`conversation create returned no id for ${definition.caseId}`);
      state.cases[definition.caseId] = {
        ...state.cases[definition.caseId],
        conversationId,
      };
      writeJsonAtomically(statePath(benchmarkRunId), state);
      for (const reelId of reelIds) {
        await retry(
          () =>
            request('POST', `/content/reels/${reelId}/share`, {
              conversationId,
              sharedWithUserId: BOT_USER_ID,
            }),
          `share ${reelId} to ${conversationId}`,
        );
      }
      const before = await request(
        'GET',
        `/conversations/${conversationId}/messages?limit=50`,
      );
      const messages = Array.isArray(before) ? before : before?.messages;
      const accessibleReelIds = [
        ...new Set(
          (messages || [])
            .map((message) => message?.media?.reelId)
            .filter(Boolean),
        ),
      ].sort();
      if (
        JSON.stringify(accessibleReelIds) !==
        JSON.stringify([...reelIds].sort())
      ) {
        fail(
          `conversation ${conversationId} has unexpected reel scope: ${JSON.stringify(accessibleReelIds)}`,
        );
      }
      const requestStartedAt = new Date().toISOString();
      const timer = Date.now();
      const userMessage = await request(
        'POST',
        `/conversations/${conversationId}/messages`,
        {
          clientMessageId: `ami-rag-${definition.caseId}-${crypto.randomUUID()}`,
          content: definition.question,
          type: 'text',
          signalType: 0,
        },
      );
      state.cases[definition.caseId] = {
        ...state.cases[definition.caseId],
        requestStartedAt,
        userMessageId: userMessage.id,
      };
      writeJsonAtomically(statePath(benchmarkRunId), state);
      let assistantMessage;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const after = await request(
          'GET',
          `/conversations/${conversationId}/messages?limit=50`,
        );
        const rows = Array.isArray(after) ? after : after?.messages || [];
        assistantMessage = rows.find(
          (message) =>
            message?.senderId === BOT_USER_ID &&
            new Date(message.createdAt).getTime() >=
              new Date(userMessage.createdAt).getTime(),
        );
        if (assistantMessage) break;
      }
      if (!assistantMessage)
        fail(
          `bot response timeout for ${definition.caseId}; no further benchmark questions were sent`,
        );
      const result = {
        ...definition,
        status: 'EVALUATED',
        conversationId,
        accessibleReelIds,
        userMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
        requestStartedAt,
        responseCompletedAt: new Date().toISOString(),
        latencyMs: Date.now() - timer,
        finalAnswer: assistantMessage.content ?? '',
        citations:
          assistantMessage.metadata?.citations ??
          assistantMessage.citations ??
          [],
      };
      result.normalized = normalizeCase(
        definition,
        result,
        null,
        benchmarkRunId,
      );
      resultCases.push(result);
      completeCase(
        state,
        definition.caseId,
        {
          conversationId,
          userMessageId: userMessage.id,
          assistantMessageId: assistantMessage.id,
          result,
        },
        (nextState) =>
          writeJsonAtomically(statePath(benchmarkRunId), nextState),
      );
      console.log(
        JSON.stringify({
          caseId: definition.caseId,
          conversationId,
          latencyMs: resultCases.at(-1).latencyMs,
        }),
      );
    }
    const report = {
      runId: benchmarkRunId,
      generatedAt: new Date().toISOString(),
      startedAt,
      mode: 'existing-ami-rag-retest-public-api',
      strategy:
        'one fresh supported group conversation per case; all dataset-defined reels shared to BOT_USER_ID before the one authorised question',
      preRun: { reelStatuses: statuses, expectedReelIds: reelIds },
      cases: resultCases,
    };
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const reportPath = path.join(REPORT_DIR, `${report.runId}.json`);
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(
      JSON.stringify({
        reportPath,
        conversationIds: resultCases.map((item) => item.conversationId),
      }),
    );
  } finally {
    releaseLock();
  }
}

module.exports = {
  formatStatus,
  buildReconciliationEvidence,
  normalizeMongoConnectionUrl,
  completeCase,
  lockRun,
  markCaseInFlight,
  pendingCases,
  reconciledResult,
  buildResponseReconciliationEvidence,
  responseReconciledResult,
  extractDistinctReelIds,
  readState,
  statePath,
  writeJsonAtomically,
};

if (require.main === module)
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
