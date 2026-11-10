import type {
  RagChatRouteDecision,
  RagGenerationEvidence,
} from '@ai/domain/interfaces/rag-chat-workflow.interface';
import {
  isTranscriptSentenceSelectionRequest,
  firstCompleteTranscriptSentenceCandidate,
  resolveOpeningTranscriptWindow,
  hasUnsupportedTranscriptTailCompletion,
  hasIncompleteTranscriptEnding,
  isLikelyIncompleteTranscriptUtterance,
  isNearVerbatimTranscriptSummary,
  isShortTerminalTranscriptUtterance,
  selectTimestampTranscriptEvidence,
  startsInsidePriorTranscriptSentence,
  transcriptFallbackSpans,
  transcriptSentenceSpans,
} from './rag-transcript-sentence-selection';

describe('transcript sentence selection inputs', () => {
  const route = {
    intent: 'REEL_VIDEO_QUESTION',
    requiredEvidence: ['TRANSCRIPT'],
    transcriptRequestKind: 'FIRST_COMPLETE_UTTERANCE',
  } as Pick<
    RagChatRouteDecision,
    'intent' | 'requiredEvidence' | 'transcriptRequestKind'
  >;

  it('requires the router to classify an earliest complete-utterance transcript task', () => {
    expect(isTranscriptSentenceSelectionRequest(route)).toBe(true);
    expect(
      isTranscriptSentenceSelectionRequest({
        ...route,
        transcriptRequestKind: 'NONE',
      }),
    ).toBe(false);
    expect(
      isTranscriptSentenceSelectionRequest({
        ...route,
        requiredEvidence: ['VISUAL'],
      }),
    ).toBe(false);
  });

  it('prefers a transcript window that covers the requested interval', () => {
    const overlapping = {
      evidenceId: 'e0',
      sourceId: 'overlap',
      evidenceType: 'TRANSCRIPT',
      startTime: 8,
      endTime: 22,
      evidenceText: 'overlap',
    } as RagGenerationEvidence;
    const aligned = {
      ...overlapping,
      evidenceId: 'e1',
      sourceId: 'aligned',
      startTime: 10,
      endTime: 20,
      evidenceText: 'aligned',
    };

    expect(
      selectTimestampTranscriptEvidence([overlapping, aligned], {
        sourceTimestampSec: 10,
        sourceTimestampEndSec: 20,
      }),
    ).toBe(aligned);
  });

  it('falls back to a transcript that contains the requested start point', () => {
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

  it('keeps punctuation-bounded utterances separate and skips clipped opening spans', () => {
    expect(
      firstCompleteTranscriptSentenceCandidate(
        "good! Now, let's deal with the rest.",
      ),
    ).toBe('good!');
    expect(
      firstCompleteTranscriptSentenceCandidate(
        'The speaker starts to say... The meeting begins now.',
      ),
    ).toBe('The meeting begins now.');
  });

  describe('resolveOpeningTranscriptWindow', () => {
    const route = {
      intent: 'REEL_VIDEO_QUESTION' as const,
      requiredEvidence: ['TRANSCRIPT' as const],
      transcriptRequestKind: 'FIRST_COMPLETE_UTTERANCE' as const,
    };
    const plan = {
      mode: 'REEL_HYBRID' as const,
      sourceOrder: 'ASC' as const,
      query: 'What is the opening statement?',
    } as never;
    const chunk = (reelId: string, startTime: number, endTime: number) => ({
      reelId,
      evidenceType: 'TRANSCRIPT',
      startTime,
      endTime,
    });

    it('uses the earliest transcript chunk of one reel as the window', () => {
      const resolved = resolveOpeningTranscriptWindow(plan, route, [
        chunk('a', 31.3, 67),
        chunk('a', 0, 67.12),
        chunk('a', 0, 31.3),
      ]);
      expect(resolved).toMatchObject({
        sourceTimestampSec: 0,
        sourceTimestampEndSec: 31.3,
      });
    });

    it('leaves requests that already name a window or need several reels alone', () => {
      expect(
        resolveOpeningTranscriptWindow(
          {
            ...(plan as object),
            sourceTimestampSec: 5,
            sourceTimestampEndSec: 9,
          } as never,
          route,
          [chunk('a', 0, 10)],
        ),
      ).toBeUndefined();
      expect(
        resolveOpeningTranscriptWindow(plan, route, [
          chunk('a', 0, 10),
          chunk('b', 0, 12),
        ]),
      ).toBeUndefined();
      expect(
        resolveOpeningTranscriptWindow(
          { ...(plan as object), requiresReelCoverage: true } as never,
          route,
          [chunk('a', 0, 10)],
        ),
      ).toBeUndefined();
    });

    it('does nothing without an ascending source order, a first-utterance route or timed transcript chunks', () => {
      expect(
        resolveOpeningTranscriptWindow(
          { mode: 'REEL_HYBRID', query: 'q' } as never,
          route,
          [chunk('a', 0, 10)],
        ),
      ).toBeUndefined();
      expect(
        resolveOpeningTranscriptWindow(
          plan,
          { ...route, transcriptRequestKind: 'NONE' as const },
          [chunk('a', 0, 10)],
        ),
      ).toBeUndefined();
      expect(
        resolveOpeningTranscriptWindow(plan, route, [
          { reelId: 'a', evidenceType: 'VISUAL', startTime: 0, endTime: 1 },
          {
            reelId: 'a',
            evidenceType: 'TRANSCRIPT',
            startTime: null,
            endTime: null,
          },
        ]),
      ).toBeUndefined();
    });
  });

  it('ignores a stray leading full stop left by transcription', () => {
    expect(
      transcriptSentenceSpans('. Get away from him, fat ass. Are you okay?'),
    ).toEqual(['Get away from him, fat ass.', 'Are you okay?']);
    expect(
      firstCompleteTranscriptSentenceCandidate(
        '. Yes, please, help her. He is alive.',
      ),
    ).toBe('Yes, please, help her.');
  });

  it('does not end a sentence after a title abbreviation', () => {
    expect(
      transcriptSentenceSpans(
        "Mr. Darius, it's high time you left my room. I'm not leaving.",
      ),
    ).toEqual([
      "Mr. Darius, it's high time you left my room.",
      "I'm not leaving.",
    ]);
    expect(transcriptSentenceSpans('Ask Dr. Smith. Then leave.')).toEqual([
      'Ask Dr. Smith.',
      'Then leave.',
    ]);
  });

  it('keeps a complete multiword in-window clause when overlap contains it inside a longer sentence', () => {
    const firstSpan = 'You arrived.';
    expect(
      startsInsidePriorTranscriptSentence(
        firstSpan,
        'The person said you arrived. The meeting began.',
      ),
    ).toBe(true);
    expect(
      firstCompleteTranscriptSentenceCandidate(
        'You arrived. The meeting began.',
        'The person said you arrived. The meeting began.',
      ),
    ).toBe(firstSpan);
  });

  it('keeps a short vocalization and polite command at overlap boundaries', () => {
    expect(
      firstCompleteTranscriptSentenceCandidate(
        'Good! The meeting began.',
        'They said it was looking good! The meeting began.',
      ),
    ).toBe('Good!');
    expect(
      firstCompleteTranscriptSentenceCandidate(
        'please, hold this. The room emptied.',
        'Yes, please, hold this. The room emptied.',
      ),
    ).toBe('please, hold this.');
  });

  it('skips a lowercase one-word tail when overlap shows it belongs to an earlier sentence', () => {
    expect(
      firstCompleteTranscriptSentenceCandidate(
        'parcel. The room emptied.',
        'I moved the parcel. The room emptied.',
      ),
    ).toBe('The room emptied.');
    expect(
      firstCompleteTranscriptSentenceCandidate(
        'please, help her. The room emptied.',
        'Yes, please, help her. The room emptied.',
      ),
    ).toBe('please, help her.');
  });

  it('recognizes short punctuated utterances without accepting clipped fragments', () => {
    expect(isShortTerminalTranscriptUtterance('good!')).toBe(true);
    expect(isShortTerminalTranscriptUtterance('No?')).toBe(true);
    expect(isShortTerminalTranscriptUtterance('Are you okay?')).toBe(false);
    expect(isShortTerminalTranscriptUtterance('Fragment 1.')).toBe(false);
    expect(isShortTerminalTranscriptUtterance('EVE pul...')).toBe(false);
  });

  it('rejects punctuated spans with a dangling auxiliary before a required phrase', () => {
    expect(isLikelyIncompleteTranscriptUtterance("I'll of a person.")).toBe(
      true,
    );
    expect(isLikelyIncompleteTranscriptUtterance("I'll of course be there.")).toBe(
      false,
    );
    expect(isLikelyIncompleteTranscriptUtterance("I'll make you laugh.")).toBe(
      false,
    );
    expect(
      firstCompleteTranscriptSentenceCandidate(
        "I'll of a person. The meeting began.",
      ),
    ).toBe('The meeting began.');
  });

  it('skips clipped, gerund, bare-noun, and subjectless predicate fragments', () => {
    expect(isLikelyIncompleteTranscriptUtterance('He...')).toBe(true);
    expect(isLikelyIncompleteTranscriptUtterance('asking whether you saw it.')).toBe(
      true,
    );
    expect(isLikelyIncompleteTranscriptUtterance('little signal.')).toBe(true);
    expect(isLikelyIncompleteTranscriptUtterance('quietly removed the sign.')).toBe(
      true,
    );
    expect(isLikelyIncompleteTranscriptUtterance('is a reasonable claim.')).toBe(
      true,
    );
    expect(isLikelyIncompleteTranscriptUtterance('Avery thought for a moment.')).toBe(
      false,
    );
    expect(isLikelyIncompleteTranscriptUtterance('I protected my mother.')).toBe(
      false,
    );
    expect(isLikelyIncompleteTranscriptUtterance('Yes.')).toBe(false);
  });

  it('does not need a reply-word allowlist for one-word utterances', () => {
    expect(isLikelyIncompleteTranscriptUtterance('ready.')).toBe(false);
    expect(isLikelyIncompleteTranscriptUtterance('help.')).toBe(false);
    expect(isLikelyIncompleteTranscriptUtterance('he.')).toBe(true);
    expect(
      firstCompleteTranscriptSentenceCandidate('ready. The meeting began.'),
    ).toBe('ready.');
  });

  it('returns the earliest remaining complete source span after generic fragments', () => {
    expect(
      firstCompleteTranscriptSentenceCandidate(
        'the visitors. asking whether you saw it. Avery thought for a moment and answered.',
      ),
    ).toBe('Avery thought for a moment and answered.');
    expect(
      firstCompleteTranscriptSentenceCandidate(
        'quietly removed the sign. Meow! The train was late.',
      ),
    ).toBe('Meow!');
  });

  it('detects completion of an unterminated transcript tail without rejecting exact-fragment reporting', () => {
    const clipped = 'They said they could conquer any nation. Crush';
    expect(
      hasUnsupportedTranscriptTailCompletion(
        'They could conquer any nation and crush them.',
        clipped,
      ),
    ).toBe(true);
    expect(
      hasUnsupportedTranscriptTailCompletion(
        'The indexed excerpt ends with the fragment "Crush".',
        clipped,
      ),
    ).toBe(false);
    expect(
      hasUnsupportedTranscriptTailCompletion(
        'They could conquer any nation.',
        clipped,
      ),
    ).toBe(false);
    expect(
      hasUnsupportedTranscriptTailCompletion(
        'They said they could conquer any nation. Crush them.',
        'They said they could conquer any nation. Crush them.',
      ),
    ).toBe(false);
  });

  it('distinguishes a near-verbatim summary from a concise paraphrase', () => {
    const source =
      'The speaker says they wanted to renovate the old house for many years. They thank the other person and describe how power could change the situation dramatically.';
    expect(
      isNearVerbatimTranscriptSummary(`The speaker says: ${source}`, source),
    ).toBe(true);
    expect(
      isNearVerbatimTranscriptSummary(
        'They had wanted to renovate for years, thanked the listener, and said the listener\'s power could change things.',
        source,
      ),
    ).toBe(false);
  });

  it('detects when a timestamp-window prefix continues a sentence in overlapping source text', () => {
    expect(
      startsInsidePriorTranscriptSentence(
        'came inside.',
        'The courier said the visitor came inside. The meeting began.',
      ),
    ).toBe(true);
    expect(
      startsInsidePriorTranscriptSentence(
        'The meeting began.',
        'The visitor came inside. The meeting began.',
      ),
    ).toBe(false);
    expect(
      startsInsidePriorTranscriptSentence(
        'A new guest arrived.',
        'No overlap.',
      ),
    ).toBe(false);
  });

  it('keeps a clause after a sentence-initial coordinating conjunction at the boundary', () => {
    const priorTranscript =
      'We planned to stay home. But the visitor decided to leave.';
    const firstSentence = 'The visitor decided to leave.';

    expect(
      startsInsidePriorTranscriptSentence(firstSentence, priorTranscript),
    ).toBe(false);
    expect(
      firstCompleteTranscriptSentenceCandidate(
        firstSentence + ' The family was surprised.',
        priorTranscript,
      ),
    ).toBe(firstSentence);
  });

  it('keeps each complete source sentence intact for quote selection', () => {
    expect(
      transcriptSentenceSpans(
        'A courier arrived. Is the package here? Yes! The meeting began.',
      ),
    ).toEqual([
      'A courier arrived.',
      'Is the package here?',
      'Yes!',
      'The meeting began.',
    ]);
    expect(
      transcriptSentenceSpans(
        'The room was quiet because the guests had left. The lights went out.',
      ),
    ).toEqual([
      'The room was quiet because the guests had left.',
      'The lights went out.',
    ]);
  });

  it('marks an unterminated source tail as incomplete without hardcoding its text', () => {
    expect(hasIncompleteTranscriptEnding("You're accepted into")).toBe(true);
    expect(hasIncompleteTranscriptEnding('The meeting ended.')).toBe(false);
    expect(hasIncompleteTranscriptEnding('The ending trails off...')).toBe(
      true,
    );
  });

  it('keeps causal clause spans available to the generic why fallback', () => {
    expect(
      transcriptFallbackSpans(
        'The room was quiet because the guests had left. The lights went out.',
        'Why did the room become quiet?',
      ),
    ).toEqual([
      'The room was quiet',
      'because the guests had left.',
      'The lights went out.',
    ]);
  });
});
