import type {
  SuggestReelQuestionsRequest,
  SuggestReelQuestionsResult,
} from '@common/ai/interfaces/reel-ask-questions.interface';

export interface IReelQuestionSuggestionService {
  suggest(
    request: SuggestReelQuestionsRequest,
  ): Promise<SuggestReelQuestionsResult>;
}
