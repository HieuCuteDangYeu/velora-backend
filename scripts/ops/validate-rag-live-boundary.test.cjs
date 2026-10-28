'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  evaluateProbe,
  probeClientMessageId,
  shouldProbeExistingConversation,
} = require('./validate-rag-live-boundary.cjs');

test('existing-conversation probes require an explicit flag and conversation ID', () => {
  assert.equal(shouldProbeExistingConversation({}, 'conversation-1'), false);
  assert.equal(
    shouldProbeExistingConversation(
      { 'probe-existing-conversation': true },
      'conversation-1',
    ),
    true,
  );
  assert.throws(
    () =>
      shouldProbeExistingConversation(
        { 'probe-existing-conversation': true },
        '',
      ),
    /conversation-id is required/,
  );
});

test('live probe client message IDs are stable for exact-once retries', () => {
  assert.equal(
    probeClientMessageId('v8-case-0045-vs-0001', 'shared'),
    probeClientMessageId('v8-case-0045-vs-0001', 'shared'),
  );
  assert.notEqual(
    probeClientMessageId('v8-case-0045-vs-0001', 'shared'),
    probeClientMessageId('v8-case-0045-vs-0001', 'unshared'),
  );
});

const sharedMessage = {
  id: 'shared-message',
  content: 'The speaker describes the shared clip.',
  metadata: {
    citations: [
      {
        reelId: 'shared-reel',
        evidenceType: 'TRANSCRIPT',
        sourceId: 'reel:shared-reel:chunk:0',
        startTime: 10,
        endTime: 56,
      },
    ],
  },
};

const unsharedMessage = {
  id: 'unshared-message',
  content:
    "I can't provide information about that Reel because it was not shared.",
  metadata: { citations: [] },
};

test('passes only when live citations stay scoped and unshared content is refused', () => {
  const result = evaluateProbe({
    sharedMessage,
    unsharedMessage,
    sharedReelId: 'shared-reel',
    unsharedReelId: 'unshared-reel',
    expectedEvidenceType: 'TRANSCRIPT',
    expectedStart: 11,
    expectedEnd: 55,
  });

  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.assertions, {
    sharedCitationPresent: true,
    sharedCitationsStayWithinConversationScope: true,
    sharedEvidenceTypeMatches: true,
    sharedTemporalRangeMatches: true,
    unsharedCitationAbsent: true,
    unsharedConversationHasNoEvidence: true,
    unsharedRequestRefused: true,
  });
});

test('fails when a live response cites the unshared Reel', () => {
  const result = evaluateProbe({
    sharedMessage,
    unsharedMessage: {
      ...unsharedMessage,
      metadata: {
        citations: [{ reelId: 'unshared-reel', evidenceType: 'TRANSCRIPT' }],
      },
    },
    sharedReelId: 'shared-reel',
    unsharedReelId: 'unshared-reel',
    expectedEvidenceType: 'TRANSCRIPT',
  });

  assert.equal(result.status, 'FAIL');
  assert.equal(result.assertions.unsharedCitationAbsent, false);
  assert.equal(result.assertions.unsharedConversationHasNoEvidence, false);
});

test('accepts the production no-context refusal wording', () => {
  const result = evaluateProbe({
    sharedMessage,
    unsharedMessage: {
      ...unsharedMessage,
      content:
        'I do not have enough verified shared reel evidence to answer that reliably.',
    },
    sharedReelId: 'shared-reel',
    unsharedReelId: 'unshared-reel',
    expectedEvidenceType: 'TRANSCRIPT',
  });

  assert.equal(result.status, 'PASS');
  assert.equal(result.assertions.unsharedRequestRefused, true);
});
