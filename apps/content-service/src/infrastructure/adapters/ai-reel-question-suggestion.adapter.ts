import type {
  SuggestReelQuestionsRequest,
  SuggestReelQuestionsResult,
} from '@common/ai/interfaces/reel-ask-questions.interface';
import type { IReelQuestionSuggestionService } from '@content/domain/interfaces/reel-question-suggestion.service.interface';
import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { lastValueFrom, timeout } from 'rxjs';

// The viewer is waiting with the comments open; past this the app keeps its generic questions.
const SUGGESTION_TIMEOUT_MS = 30_000;

@Injectable()
export class AiReelQuestionSuggestionAdapter implements IReelQuestionSuggestionService {
  constructor(
    @Inject('AI_SERVICE_RMQ')
    private readonly aiClient: ClientProxy,
  ) {}

  suggest(
    request: SuggestReelQuestionsRequest,
  ): Promise<SuggestReelQuestionsResult> {
    return lastValueFrom(
      this.aiClient
        .send<SuggestReelQuestionsResult>('ai.suggest_reel_questions', request)
        .pipe(timeout(SUGGESTION_TIMEOUT_MS)),
    );
  }
}
