import type {
  TranslateSubtitleCuesRequest,
  TranslateSubtitleCuesResult,
} from '@common/ai/interfaces/subtitle-translation.interface';

export interface ISubtitleTranslationService {
  translate(
    request: TranslateSubtitleCuesRequest,
  ): Promise<TranslateSubtitleCuesResult>;
}
