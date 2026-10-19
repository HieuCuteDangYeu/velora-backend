#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const DEFAULT_BOT_USER_ID = 'b6ddf921-c87c-4f68-8d71-f1b1fd33f3e7';

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

function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex');
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function messageRows(payload) {
  return Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.messages)
      ? payload.messages
      : [];
}

function citationsFromMessage(message) {
  const citations = message?.metadata?.citations ?? message?.citations;
  return Array.isArray(citations) ? citations : [];
}

function findBotMessage(payload, botUserId, userCreatedAt) {
  const threshold = new Date(userCreatedAt ?? 0).getTime();
  return messageRows(payload).find(
    (message) =>
      message?.senderId === botUserId &&
      new Date(message.createdAt ?? 0).getTime() >= threshold,
  );
}

function safeMessageObservation(message) {
  const answer = typeof message?.content === 'string' ? message.content : '';
  const citations = citationsFromMessage(message);
  return {
    messageId: typeof message?.id === 'string' ? message.id : null,
    answerLength: answer.length,
    answerSha256: sha256(answer),
    citationCount: citations.length,
    citations: citations.map((citation) => ({
      reelId: typeof citation?.reelId === 'string' ? citation.reelId : null,
      evidenceType:
        typeof citation?.evidenceType === 'string'
          ? citation.evidenceType
          : null,
      sourceId:
        typeof citation?.sourceId === 'string' ? citation.sourceId : null,
      startTime: Number.isFinite(citation?.startTime)
        ? citation.startTime
        : null,
      endTime: Number.isFinite(citation?.endTime) ? citation.endTime : null,
    })),
  };
}

function isAccessRefusal(message) {
  const answer = typeof message?.content === 'string' ? message.content : '';
  return /(?:not shared|wasn't shared|was not shared|don't have access|do not have access|can't provide|cannot provide|unable to|no information about its content|not available)/i.test(answer);
}

function hasExpectedTemporalCitation(citations, expected) {
  if (expected.start === undefined && expected.end === undefined) return true;
  return citations.some((citation) => {
    if (!Number.isFinite(citation?.startTime) || !Number.isFinite(citation?.endTime)) return false;
    if (expected.start !== undefined && citation.startTime > expected.start) return false;
    if (expected.end !== undefined && citation.endTime < expected.end) return false;
    return true;
  });
}

function evaluateProbe({ sharedMessage, unsharedMessage, sharedReelId, unsharedReelId, expectedEvidenceType, expectedStart, expectedEnd }) {
  const sharedCitations = citationsFromMessage(sharedMessage);
  const unsharedCitations = citationsFromMessage(unsharedMessage);
  const sharedCitationReelIds = [...new Set(sharedCitations.map((citation) => citation?.reelId).filter(Boolean))];
  const unsharedCitationReelIds = [...new Set(unsharedCitations.map((citation) => citation?.reelId).filter(Boolean))];
  const assertions = {
    sharedCitationPresent: sharedCitationReelIds.includes(sharedReelId),
    sharedCitationsStayWithinConversationScope: sharedCitationReelIds.every((reelId) => reelId === sharedReelId),
    sharedEvidenceTypeMatches: expectedEvidenceType
      ? sharedCitations.some((citation) => citation?.reelId === sharedReelId && citation?.evidenceType === expectedEvidenceType)
      : true,
    sharedTemporalRangeMatches: hasExpectedTemporalCitation(sharedCitations, {
      start: expectedStart,
      end: expectedEnd,
    }),
    unsharedCitationAbsent: !unsharedCitationReelIds.includes(unsharedReelId),
    unsharedConversationHasNoEvidence: unsharedCitations.length === 0,
    unsharedRequestRefused: isAccessRefusal(unsharedMessage),
  };
  return {
    status: Object.values(assertions).every(Boolean) ? 'PASS' : 'FAIL',
    assertions,
    shared: safeMessageObservation(sharedMessage),
    unshared: safeMessageObservation(unsharedMessage),
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function apiClient(baseUrl, credentials) {
  let cookies = '';
  return async function request(method, pathname, body) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(new URL(pathname, `${baseUrl.replace(/\/$/, '')}/`), {
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
        continue;
      }
      if (!response.ok) {
        throw new Error(`${method} ${pathname} failed (${response.status})`);
      }
      return payload;
    }
    throw new Error(`${method} ${pathname} exhausted retries`);
  };
}

async function waitForBotMessage(request, conversationId, botUserId, userCreatedAt) {
  const maxAttempts = Number(process.env.RAG_LIVE_BOUNDARY_POLL_ATTEMPTS || 60);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await sleep(2_000);
    const messages = await request(
      'GET',
      `/conversations/${conversationId}/messages?limit=50`,
    );
    const assistant = findBotMessage(messages, botUserId, userCreatedAt);
    if (assistant) return assistant;
  }
  throw new Error(`bot response timeout for ${conversationId}`);
}

async function sendQuestion(request, conversationId, botUserId, question, runId, label) {
  const userMessage = await request('POST', `/conversations/${conversationId}/messages`, {
    clientMessageId: `rag-live-boundary-${runId}-${label}-${crypto.randomUUID()}`,
    content: question,
    type: 'text',
    signalType: 0,
  });
  return waitForBotMessage(
    request,
    conversationId,
    botUserId,
    userMessage?.createdAt ?? new Date().toISOString(),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  dotenv.config({ path: args['backend-env'] || path.resolve(process.cwd(), '.env.test.local') });
  dotenv.config({ path: args['runtime-env'] || path.resolve(process.cwd(), '.env') });

  const baseUrl = String(args['backend-url'] || process.env.BACKEND_URL || '').trim();
  const email = process.env.VELORA_TEST_EMAIL;
  const password = process.env.VELORA_TEST_PASSWORD;
  const botUserId = String(args['bot-user-id'] || process.env.BOT_USER_ID || DEFAULT_BOT_USER_ID).trim();
  const sharedReelId = String(args['shared-reel-id'] || process.env.RAG_LIVE_SHARED_REEL_ID || '').trim();
  const unsharedReelId = String(args['unshared-reel-id'] || process.env.RAG_LIVE_UNSHARED_REEL_ID || '').trim();
  const sharedQuestion = String(args['shared-question'] || process.env.RAG_LIVE_SHARED_QUESTION || '').trim();
  const unsharedQuestion = String(args['unshared-question'] || process.env.RAG_LIVE_UNSHARED_QUESTION || '').trim();
  const releaseSha = String(args['release-sha'] || process.env.RAG_RELEASE_SHA || '').trim();
  const outputPath = path.resolve(String(args.output || process.env.RAG_LIVE_BOUNDARY_OUTPUT || '.benchmarks/rag-live-boundary-validation.json'));
  const expectedEvidenceType = String(args['expected-evidence-type'] || process.env.RAG_LIVE_EXPECTED_EVIDENCE_TYPE || 'TRANSCRIPT').trim();
  const expectedStart = args['expected-start'] === undefined ? undefined : Number(args['expected-start']);
  const expectedEnd = args['expected-end'] === undefined ? undefined : Number(args['expected-end']);
  const startedAt = new Date().toISOString();
  const result = {
    schemaVersion: 'rag-production-retrieval-validation-v1',
    status: 'FAIL',
    startedAt,
    finishedAt: null,
    releaseSha: releaseSha || null,
    backendHost: baseUrl ? new URL(baseUrl).host : null,
    sharedReelId: sharedReelId || null,
    unsharedReelId: unsharedReelId || null,
    conversationId: null,
    probe: {
      expectedEvidenceType: expectedEvidenceType || null,
      expectedStart: Number.isFinite(expectedStart) ? expectedStart : null,
      expectedEnd: Number.isFinite(expectedEnd) ? expectedEnd : null,
    },
  };

  try {
    if (!baseUrl || !email || !password || !botUserId || !sharedReelId || !unsharedReelId || !sharedQuestion || !unsharedQuestion || !releaseSha) {
      throw new Error('backend credentials, release SHA, probe Reel IDs and questions are required');
    }
    if (sharedReelId === unsharedReelId) throw new Error('shared and unshared Reel IDs must differ');
    if ((expectedStart !== undefined && !Number.isFinite(expectedStart)) || (expectedEnd !== undefined && !Number.isFinite(expectedEnd))) {
      throw new Error('expected temporal bounds must be finite numbers');
    }
    const request = apiClient(baseUrl, { email, password });
    await request('POST', '/auth/login', { email, password });
    const resumedConversationId = String(args['conversation-id'] || process.env.RAG_LIVE_BOUNDARY_CONVERSATION_ID || '').trim();
    const resumedSharedMessageId = String(args['shared-message-id'] || process.env.RAG_LIVE_BOUNDARY_SHARED_MESSAGE_ID || '').trim();
    let conversationId = resumedConversationId;
    let sharedMessage;
    if (resumedConversationId) {
      if (!resumedSharedMessageId) throw new Error('--shared-message-id is required when resuming a conversation');
      const messages = await request('GET', `/conversations/${resumedConversationId}/messages?limit=50`);
      sharedMessage = messageRows(messages).find((message) => message?.id === resumedSharedMessageId);
      if (!sharedMessage) throw new Error(`shared message ${resumedSharedMessageId} was not found in the resumed conversation`);
    } else {
      const conversation = await request('POST', '/conversations', {
        participantIds: [botUserId],
        type: 'GROUP',
        isGroup: true,
        name: `RAG live boundary ${releaseSha.slice(0, 12)}`,
      });
      conversationId = conversation?.id;
      if (!conversationId) throw new Error('conversation create returned no id');
      await request('POST', `/content/reels/${sharedReelId}/share`, {
        conversationId,
        sharedWithUserId: botUserId,
      });
      sharedMessage = await sendQuestion(
        request,
        conversationId,
        botUserId,
        sharedQuestion,
        releaseSha.slice(0, 12),
        'shared',
      );
    }
    result.conversationId = conversationId;
    const unsharedMessage = await sendQuestion(
      request,
      conversationId,
      botUserId,
      unsharedQuestion,
      releaseSha.slice(0, 12),
      'unshared',
    );
    const probe = evaluateProbe({
      sharedMessage,
      unsharedMessage,
      sharedReelId,
      unsharedReelId,
      expectedEvidenceType,
      expectedStart,
      expectedEnd,
    });
    Object.assign(result, probe);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  result.finishedAt = new Date().toISOString();
  writeJson(outputPath, result);
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'PASS') process.exitCode = 2;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  citationsFromMessage,
  evaluateProbe,
  hasExpectedTemporalCitation,
  isAccessRefusal,
  safeMessageObservation,
};
