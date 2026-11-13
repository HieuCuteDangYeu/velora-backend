import type {
  TranscriptionResult,
  TranscriptSegment,
} from '@common/ai/interfaces/transcription-result.interface';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { IStructuredLlmService } from '../../domain/interfaces/structured-llm.service.interface';

interface SegmentTranslationEntry {
  id: number;
  textEn: string;
  textVi: string;
}

interface RawTranslationResponse {
  translations?: SegmentTranslationEntry[];
}

@Injectable()
export class TranslateTranscriptUseCase {
  private readonly logger = new Logger(TranslateTranscriptUseCase.name);

  constructor(
    @Inject('IStructuredLlmService')
    private readonly structuredLlmService: IStructuredLlmService,
  ) {}

  async execute(result: TranscriptionResult): Promise<TranscriptionResult> {
    const segments = result.segments ?? [];
    const text = result.text?.trim() ?? '';
    if (!text && segments.length === 0) {
      return result;
    }

    const detectedLanguage = this.normalizeLanguage(result.detectedLanguage);

    try {
      if (segments.length > 0) {
        return await this.translateSegments(result, segments, detectedLanguage);
      }
      return await this.translateFullText(result, text, detectedLanguage);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Transcript translation skipped due to error: ${message}`,
      );
      return result;
    }
  }

  private async translateSegments(
    result: TranscriptionResult,
    segments: TranscriptSegment[],
    detectedLanguage: string,
  ): Promise<TranscriptionResult> {
    const BATCH_SIZE = 25;
    const translatedSegments: TranscriptSegment[] = [...segments];

    for (let i = 0; i < segments.length; i += BATCH_SIZE) {
      const batch = segments.slice(i, i + BATCH_SIZE);
      const batchPrompt = batch
        .map((segment, index) => {
          const id = segment.id ?? i + index;
          return `[${id}]: ${segment.text.trim()}`;
        })
        .join('\n');

      const response =
        await this.structuredLlmService.generateObject<RawTranslationResponse>({
          systemPrompt:
            'You are an expert audiovisual translator. Translate the given spoken dialogue transcript segments into natural English (en) and Vietnamese (vi). Preserve colloquial nuances, character names, and tone. Return a JSON object with a "translations" array containing { id, textEn, textVi } for each input segment.',
          userPrompt: `Source language: ${detectedLanguage}\nSegments:\n${batchPrompt}`,
          jsonSchema: {
            type: 'object',
            properties: {
              translations: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'number' },
                    textEn: { type: 'string' },
                    textVi: { type: 'string' },
                  },
                  required: ['id', 'textEn', 'textVi'],
                  additionalProperties: false,
                },
              },
            },
            required: ['translations'],
            additionalProperties: false,
          },
        });

      const translationMap = new Map<number, SegmentTranslationEntry>();
      for (const item of response.translations ?? []) {
        if (typeof item.id === 'number') {
          translationMap.set(item.id, item);
        }
      }

      for (let j = 0; j < batch.length; j += 1) {
        const segmentIndex = i + j;
        const segment = translatedSegments[segmentIndex];
        const id = segment.id ?? segmentIndex;
        const translation = translationMap.get(id);

        segment.originalText = segment.text;
        segment.detectedLanguage = detectedLanguage;

        if (translation) {
          segment.textEn = translation.textEn.trim();
          segment.textVi = translation.textVi.trim();
          if (detectedLanguage !== 'en' && segment.textEn) {
            segment.text = segment.textEn;
          }
        } else if (detectedLanguage === 'en') {
          segment.textEn = segment.text;
        } else if (detectedLanguage === 'vi') {
          segment.textVi = segment.text;
        }
      }
    }

    const textEn = translatedSegments
      .map((s) => s.textEn)
      .filter((t): t is string => Boolean(t))
      .join(' ');
    const textVi = translatedSegments
      .map((s) => s.textVi)
      .filter((t): t is string => Boolean(t))
      .join(' ');

    return {
      ...result,
      text: detectedLanguage !== 'en' && textEn ? textEn : result.text,
      textEn: textEn || (detectedLanguage === 'en' ? result.text : undefined),
      textVi: textVi || (detectedLanguage === 'vi' ? result.text : undefined),
      detectedLanguage,
      segments: translatedSegments,
    };
  }

  private async translateFullText(
    result: TranscriptionResult,
    text: string,
    detectedLanguage: string,
  ): Promise<TranscriptionResult> {
    const response = await this.structuredLlmService.generateObject<{
      textEn?: string;
      textVi?: string;
    }>({
      systemPrompt:
        'You are an expert audiovisual translator. Translate the given spoken transcript text into natural English (en) and Vietnamese (vi). Preserve tone and colloquial expressions.',
      userPrompt: `Source language: ${detectedLanguage}\nText:\n${text}`,
      jsonSchema: {
        type: 'object',
        properties: {
          textEn: { type: 'string' },
          textVi: { type: 'string' },
        },
        required: ['textEn', 'textVi'],
        additionalProperties: false,
      },
    });

    const textEn = response.textEn?.trim();
    const textVi = response.textVi?.trim();

    return {
      ...result,
      text: detectedLanguage !== 'en' && textEn ? textEn : result.text,
      textEn: textEn || (detectedLanguage === 'en' ? result.text : undefined),
      textVi: textVi || (detectedLanguage === 'vi' ? result.text : undefined),
      detectedLanguage,
    };
  }

  private normalizeLanguage(lang?: string): string {
    if (!lang) return 'auto';
    const lower = lang.trim().toLowerCase();
    if (lower === 'chinese' || lower === 'zh' || lower === 'mandarin')
      return 'zh';
    if (lower === 'english' || lower === 'en') return 'en';
    if (lower === 'vietnamese' || lower === 'vi') return 'vi';
    return lower;
  }
}
