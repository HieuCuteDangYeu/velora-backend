import {
  REEL_ASK_QUESTION_COUNT,
  REEL_ASK_QUESTION_MAX_CHARS,
  REEL_ASK_TRANSCRIPT_MAX_CHARS,
} from '@common/ai/interfaces/reel-ask-questions.interface';
import type { TranscriptSegment } from '@common/ai/interfaces/transcription-result.interface';
import type { Reel } from '@content/domain/entities/reel.entity';
import type { IReelQuestionSuggestionService } from '@content/domain/interfaces/reel-question-suggestion.service.interface';
import { detectTranscriptLanguage } from '@content/domain/subtitle-cues';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { GetReelUseCase } from './get-reel.use-case';

export interface ReelAskQuestions {
  reelId: string;
  questions: string[];
}

/** The subset of ioredis the cache needs. */
export interface ReelAskQuestionCache {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    mode: 'EX',
    seconds: number,
  ): Promise<unknown>;
}

const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
// A reel the model found nothing to ask about is retried after an hour, not on every open.
const EMPTY_CACHE_TTL_SECONDS = 60 * 60;

@Injectable()
export class GetReelAskQuestionsUseCase {
  private readonly logger = new Logger(GetReelAskQuestionsUseCase.name);
  // Viewers opening the same reel at once share one model call.
  private readonly inFlight = new Map<string, Promise<string[]>>();

  constructor(
    private readonly getReel: GetReelUseCase,
    @Inject('IReelQuestionSuggestionService')
    private readonly suggestions: IReelQuestionSuggestionService,
    @Inject('REDIS_CLIENT')
    private readonly cache: ReelAskQuestionCache,
  ) {}

  /** Returns null when the reel does not exist or the viewer may not see it. */
  async execute(input: {
    reelId: string;
    viewerId: string;
    isAdmin?: boolean;
  }): Promise<ReelAskQuestions | null> {
    const reel = await this.getReel.execute(
      input.reelId,
      input.viewerId,
      input.isAdmin === true,
    );
    if (!reel) return null;

    const transcript = sampleTranscript(reel);
    if (!transcript) return { reelId: reel.id, questions: [] };

    const version = (reel.indexCompletedAt ?? reel.updatedAt)?.getTime?.() ?? 0;
    const key = `reel:ask-questions:v1:${reel.id}:${version}`;
    const cached = await this.readCache(key);
    if (cached) return { reelId: reel.id, questions: cached };

    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.generate(reel, transcript, key).finally(() =>
        this.inFlight.delete(key),
      );
      this.inFlight.set(key, pending);
    }
    return { reelId: reel.id, questions: await pending };
  }

  private async generate(
    reel: Reel,
    transcript: string,
    key: string,
  ): Promise<string[]> {
    try {
      const result = await this.suggestions.suggest({
        title: reel.title,
        description: reel.description,
        tags: reel.tags ?? [],
        transcript,
        language: detectTranscriptLanguage(reel.transcriptSegments ?? []),
      });
      const questions = (result?.questions ?? [])
        .filter(
          (question): question is string =>
            typeof question === 'string' &&
            question.trim().length > 0 &&
            question.length <= REEL_ASK_QUESTION_MAX_CHARS + 1,
        )
        .slice(0, REEL_ASK_QUESTION_COUNT);
      await this.cache
        .set(
          key,
          JSON.stringify(questions),
          'EX',
          questions.length ? CACHE_TTL_SECONDS : EMPTY_CACHE_TTL_SECONDS,
        )
        .catch(() => undefined);
      return questions;
    } catch (error: unknown) {
      // Not cached: the app shows its generic questions and the next open tries again.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[ReelAskQuestions] reel=${reel.id} ${message}`);
      return [];
    }
  }

  private async readCache(key: string): Promise<string[] | null> {
    try {
      const raw = await this.cache.get(key);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string')
        : null;
    } catch {
      return null;
    }
  }
}

/**
 * Transcript text spread over the whole reel, not just its opening, so the questions can reach its middle and end.
 */
export function sampleTranscript(
  reel: Pick<Reel, 'transcript' | 'transcriptSegments'>,
  maxChars = REEL_ASK_TRANSCRIPT_MAX_CHARS,
): string {
  const segments: TranscriptSegment[] = (reel.transcriptSegments ?? []).filter(
    (segment) => segment.text?.trim(),
  );
  if (segments.length === 0) {
    const text = reel.transcript?.replace(/\s+/gu, ' ').trim() ?? '';
    if (text.length <= maxChars) return text;
    const part = Math.floor(maxChars / 3);
    const middle = Math.floor(text.length / 2 - part / 2);
    return [
      text.slice(0, part),
      text.slice(middle, middle + part),
      text.slice(text.length - part),
    ].join(' … ');
  }

  const all = segments.map((segment) => segment.text.trim()).join(' ');
  if (all.length <= maxChars) return all;

  // Take every n-th segment so the sample covers the reel evenly.
  const average = all.length / segments.length;
  const step = Math.max(1, Math.ceil(segments.length / (maxChars / average)));
  const picked: string[] = [];
  let length = 0;
  for (let index = 0; index < segments.length; index += step) {
    const text = segments[index].text.trim();
    if (length + text.length + 3 > maxChars) break;
    picked.push(text);
    length += text.length + 3;
  }
  return picked.join(' … ');
}
