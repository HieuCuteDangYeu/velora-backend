import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import type { IStructuredLlmService } from '@ai/domain/interfaces/structured-llm.service.interface';
import {
  SUBTITLE_TRANSLATION_MAX_CUES,
  SUBTITLE_TRANSLATION_MAX_CUE_CHARS,
  isSubtitleTargetLanguage,
  type SubtitleTranslationCue,
  type TranslateSubtitleCuesRequest,
  type TranslateSubtitleCuesResult,
} from '@common/ai/interfaces/subtitle-translation.interface';
import { Inject, Injectable, Logger } from '@nestjs/common';

interface RawTranslation {
  translations?: Array<{ index?: unknown; text?: unknown }>;
}

const BATCH_SIZE = 20;
const MAX_ATTEMPTS = 3;

const LANGUAGE_NAMES: Record<string, string> = {
  vi: 'Vietnamese',
  en: 'English',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
};

export class InvalidSubtitleTranslationRequestError extends Error {}

/**
 * Translates subtitle lines one batch at a time. Every input line must come back translated: a reel with a missing line
 * is an error, not a half-translated track, so the caller never stores a partial result.
 */
@Injectable()
export class TranslateSubtitleCuesUseCase {
  private readonly logger = new Logger(TranslateSubtitleCuesUseCase.name);

  constructor(
    @Inject('IStructuredLlmService')
    private readonly structuredLlm: IStructuredLlmService,
    @Inject('IAiApplicationConfig')
    private readonly config: IAiApplicationConfig,
  ) {}

  async execute(
    request: TranslateSubtitleCuesRequest,
  ): Promise<TranslateSubtitleCuesResult> {
    const input = this.validate(request);
    const model = this.config.model('SUBTITLE_TRANSLATION');
    if (input.sourceLanguage === input.targetLanguage) {
      return { cues: input.cues, model: 'none' };
    }

    const translated = new Map<number, string>();
    for (let from = 0; from < input.cues.length; from += BATCH_SIZE) {
      const batch = input.cues.slice(from, from + BATCH_SIZE);
      const previous = input.cues[from - 1]?.text;
      await this.translateBatch(batch, previous, input, translated);
    }

    this.logger.log(
      `Translated ${input.cues.length} subtitle line(s) ${input.sourceLanguage}->${input.targetLanguage} with ${model}`,
    );
    return {
      cues: input.cues.map((cue) => ({
        index: cue.index,
        text: translated.get(cue.index) as string,
      })),
      model,
    };
  }

  private async translateBatch(
    batch: SubtitleTranslationCue[],
    previousLine: string | undefined,
    request: TranslateSubtitleCuesRequest,
    translated: Map<number, string>,
  ): Promise<void> {
    let pending = batch;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const raw = await this.structuredLlm.generateObject<RawTranslation>({
        modelRole: 'SUBTITLE_TRANSLATION',
        model: this.config.model('SUBTITLE_TRANSLATION'),
        maxTokens: this.config.maxCompletionTokens('SUBTITLE_TRANSLATION'),
        timeoutMs: this.config.timeoutMs('SUBTITLE_TRANSLATION'),
        temperature: 0.1,
        attempt,
        systemPrompt: this.systemPrompt(request),
        userPrompt: this.userPrompt(pending, previousLine, request.title),
        jsonSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['translations'],
          properties: {
            translations: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['index', 'text'],
                properties: {
                  index: { type: 'number' },
                  text: { type: 'string' },
                },
              },
            },
          },
        },
      });

      const wanted = new Set(pending.map((cue) => cue.index));
      for (const item of raw.translations ?? []) {
        const text = typeof item.text === 'string' ? item.text.trim() : '';
        if (typeof item.index === 'number' && wanted.has(item.index) && text) {
          translated.set(item.index, text);
        }
      }
      pending = pending.filter((cue) => !translated.has(cue.index));
      if (pending.length === 0) return;
      this.logger.warn(
        `Subtitle translation attempt ${attempt} left ${pending.length} of ${batch.length} line(s) untranslated`,
      );
    }
    throw new Error(
      `Subtitle translation did not return ${pending.length} line(s) after ${MAX_ATTEMPTS} attempts`,
    );
  }

  private systemPrompt(request: TranslateSubtitleCuesRequest): string {
    const source =
      LANGUAGE_NAMES[request.sourceLanguage] ?? request.sourceLanguage;
    const target = LANGUAGE_NAMES[request.targetLanguage];
    return [
      `You translate on-screen subtitles from ${source} into natural ${target}.`,
      'The lines come from automatic speech recognition, so they may contain mistakes; translate what was most likely said and never invent content that is not there.',
      'Return exactly one translation for every input line, using the same index. Do not merge, split, skip or reorder lines.',
      'Keep each translation short enough to read on a phone while it is on screen. Keep names of people consistent across lines. No notes, no quotation marks, no line numbers in the text.',
    ].join(' ');
  }

  private userPrompt(
    batch: SubtitleTranslationCue[],
    previousLine: string | undefined,
    title: string | undefined,
  ): string {
    const parts: string[] = [];
    if (title) parts.push(`Video title (for names only): ${title}`);
    if (previousLine) {
      parts.push(
        `The line just before these (context, do not translate): ${previousLine}`,
      );
    }
    parts.push(
      'Lines to translate:',
      ...batch.map((cue) => `[${cue.index}] ${cue.text}`),
    );
    return parts.join('\n');
  }

  private validate(
    request: TranslateSubtitleCuesRequest,
  ): TranslateSubtitleCuesRequest {
    if (!request || typeof request !== 'object') {
      throw new InvalidSubtitleTranslationRequestError(
        'Invalid subtitle translation request',
      );
    }
    if (!isSubtitleTargetLanguage(request.targetLanguage)) {
      throw new InvalidSubtitleTranslationRequestError(
        'Unsupported subtitle target language',
      );
    }
    const source =
      typeof request.sourceLanguage === 'string'
        ? request.sourceLanguage.trim().toLowerCase()
        : '';
    if (!/^[a-z]{2,3}$/.test(source)) {
      throw new InvalidSubtitleTranslationRequestError(
        'Invalid source language',
      );
    }
    const cues = request.cues;
    if (
      !Array.isArray(cues) ||
      cues.length === 0 ||
      cues.length > SUBTITLE_TRANSLATION_MAX_CUES
    ) {
      throw new InvalidSubtitleTranslationRequestError(
        `Expected between 1 and ${SUBTITLE_TRANSLATION_MAX_CUES} subtitle lines`,
      );
    }
    const seen = new Set<number>();
    const clean = cues.map((cue) => {
      const text = typeof cue?.text === 'string' ? cue.text.trim() : '';
      if (
        !Number.isInteger(cue?.index) ||
        seen.has(cue.index) ||
        !text ||
        text.length > SUBTITLE_TRANSLATION_MAX_CUE_CHARS
      ) {
        throw new InvalidSubtitleTranslationRequestError(
          'Invalid subtitle line',
        );
      }
      seen.add(cue.index);
      return { index: cue.index, text };
    });
    return {
      sourceLanguage: source,
      targetLanguage: request.targetLanguage,
      ...(typeof request.title === 'string' && request.title.trim()
        ? { title: request.title.trim().slice(0, 200) }
        : {}),
      cues: clean,
    };
  }
}
