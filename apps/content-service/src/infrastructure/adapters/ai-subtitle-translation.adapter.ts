import type {
  TranslateSubtitleCuesRequest,
  TranslateSubtitleCuesResult,
} from '@common/ai/interfaces/subtitle-translation.interface';
import { isRpcError } from '@common/constants/rpc-error.types';
import type { ISubtitleTranslationService } from '@content/domain/interfaces/subtitle-translation.service.interface';
import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { catchError, lastValueFrom, timeout } from 'rxjs';

// Several batches of a small local model; a reel normally takes under two minutes.
const TRANSLATION_TIMEOUT_MS = 5 * 60 * 1000;

@Injectable()
export class AiSubtitleTranslationAdapter implements ISubtitleTranslationService {
  constructor(
    @Inject('AI_SERVICE_RMQ')
    private readonly aiClient: ClientProxy,
  ) {}

  translate(
    request: TranslateSubtitleCuesRequest,
  ): Promise<TranslateSubtitleCuesResult> {
    return lastValueFrom(
      this.aiClient
        .send<TranslateSubtitleCuesResult>(
          'ai.translate_subtitle_cues',
          request,
        )
        .pipe(
          timeout(TRANSLATION_TIMEOUT_MS),
          catchError((error: unknown) => {
            if (isRpcError(error)) {
              const message = Array.isArray(error.message)
                ? error.message.join(', ')
                : error.message;
              throw new Error(
                `AI service error [${error.statusCode}]: ${message}`,
              );
            }
            const message =
              error instanceof Error ? error.message : String(error);
            throw new Error(`AI service unreachable: ${message}`);
          }),
        ),
    );
  }
}
