import type {
  RagChatRouteDecision,
  RagGenerationEvidence,
} from '@ai/domain/interfaces/rag-chat-workflow.interface';
import {
  isTranscriptSentenceSelectionRequest,
  reconcileTranscriptSentenceCandidate,
  selectTimestampTranscriptEvidence,
} from './rag-transcript-sentence-selection';

describe('transcript sentence selection policy', () => {
  const route = {
    intent: 'REEL_VIDEO_QUESTION',
    requiredEvidence: ['TRANSCRIPT'],
  } as Pick<RagChatRouteDecision, 'intent' | 'requiredEvidence'>;

  it('only enables ordered selection for explicit first-sentence transcript requests', () => {
    expect(
      isTranscriptSentenceSelectionRequest(
        route,
        'Quote the first complete sentence in the transcript.',
      ),
    ).toBe(true);
    expect(
      isTranscriptSentenceSelectionRequest(route, 'Quote what she says next.'),
    ).toBe(false);
    expect(
      isTranscriptSentenceSelectionRequest(
        { ...route, requiredEvidence: ['VISUAL'] },
        'Quote the first complete sentence.',
      ),
    ).toBe(false);
  });

  it('prefers a transcript window covering the requested range', () => {
    const overlapping = {
      evidenceId: 'e0',
      sourceId: 'overlap',
      evidenceType: 'TRANSCRIPT',
      startTime: 9.06,
      endTime: 76.25,
      evidenceText: 'overlap',
    } as RagGenerationEvidence;
    const aligned = {
      ...overlapping,
      evidenceId: 'e1',
      sourceId: 'aligned',
      startTime: 9.52,
      endTime: 62.28,
      evidenceText: 'aligned',
    };

    expect(
      selectTimestampTranscriptEvidence([overlapping, aligned], {
        sourceTimestampSec: 9.52,
        sourceTimestampEndSec: 62.28,
      }),
    ).toBe(aligned);
  });

  it('falls back to a transcript containing the requested start point', () => {
    const evidence = {
      evidenceId: 'e0',
      sourceId: 'point',
      evidenceType: 'TRANSCRIPT',
      startTime: 0.64,
      endTime: 45.44,
      evidenceText: 'point',
    } as RagGenerationEvidence;

    expect(
      selectTimestampTranscriptEvidence([evidence], {
        sourceTimestampSec: 0.82,
        sourceTimestampEndSec: 51.6,
      }),
    ).toBe(evidence);
    expect(
      selectTimestampTranscriptEvidence([evidence], {
        sourceTimestampSec: 50,
        sourceTimestampEndSec: 60,
      }),
    ).toBeUndefined();
  });

  it('skips clear noun and adjective fragments for a complete sentence', () => {
    expect(
      reconcileTranscriptSentenceCandidate(
        [
          { candidateId: 'one', text: 'the red notebook!' },
          { candidateId: 'two', text: 'Where is it?' },
        ],
        'one',
      ),
    ).toBe('two');
    expect(
      reconcileTranscriptSentenceCandidate(
        [
          { candidateId: 'one', text: 'House Green Lantern.' },
          { candidateId: 'two', text: 'The signal is clear.' },
        ],
        'one',
      ),
    ).toBe('two');
    expect(
      reconcileTranscriptSentenceCandidate(
        [
          { candidateId: 'one', text: 'too large.' },
          { candidateId: 'two', text: 'is a serious problem.' },
          { candidateId: 'three', text: 'Avery has filed the report.' },
        ],
        'one',
      ),
    ).toBe('three');
  });

  it('restores an earlier complete clause when the model selects a later one', () => {
    expect(
      reconcileTranscriptSentenceCandidate(
        [
          { candidateId: 'one', text: "you're setting the table." },
          { candidateId: 'two', text: "Please, there's no reason." },
        ],
        'two',
      ),
    ).toBe('one');
  });

  it('preserves model choices for short and elliptical utterances', () => {
    expect(
      reconcileTranscriptSentenceCandidate(
        [
          { candidateId: 'one', text: 'Only after lunch?' },
          { candidateId: 'two', text: 'The meeting started at noon.' },
        ],
        'one',
      ),
    ).toBe('one');
    expect(
      reconcileTranscriptSentenceCandidate(
        [{ candidateId: 'one', text: 'No.' }],
        'one',
      ),
    ).toBe('one');
  });

  it('does not promote a malformed modal fragment or a dangling infinitive', () => {
    expect(
      reconcileTranscriptSentenceCandidate(
        [
          { candidateId: 'one', text: "I'll of a sudden." },
          { candidateId: 'two', text: 'Volunteered to be my guard.' },
          { candidateId: 'three', text: 'I wrote a note.' },
        ],
        'three',
      ),
    ).toBe('three');
  });

  it('recognizes a complete topical clause beginning with “As for”', () => {
    expect(
      reconcileTranscriptSentenceCandidate(
        [
          { candidateId: 'one', text: 'As for the report, it was delayed.' },
          { candidateId: 'two', text: 'The next meeting begins tomorrow.' },
        ],
        'two',
      ),
    ).toBe('one');
  });
});
